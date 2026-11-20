"""OpenList adapter and Telegram notifier against mocked HTTP."""

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from app.services.anime.drive import CloudTaskState, DirEntry, DriveError, PlayLinks
from app.services.anime.notify import (
    CAPTION_LIMIT,
    Button,
    Notification,
    NotifyError,
    ReleaseInfo,
    TelegramNotifier,
    compose_completed,
    compose_failed,
    visible_length,
)
from app.services.anime.openlist import OpenListAdapter

HASH = "409486487caa006f7afae7a3a432f7fb99b1f7a4"


class FakeOpenList:
    """Minimal OpenList v4 API: HTTP 200 with the real status in the body."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.dirs = {"/pikpak/Anime-Tracker"}
        self.tasks: list[dict[str, Any]] = []
        self.done: list[dict[str, Any]] = []
        self.token_valid = True
        self.logins = 0
        self.mkdir_code = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((path, body))
        if path == "/api/auth/login":
            self.logins += 1
            self.token_valid = True
            return self._ok({"token": f"t{self.logins}"})
        if not self.token_valid or not request.headers.get("Authorization"):
            return httpx.Response(200, json={"code": 401, "message": "token is invalidated"})
        if path == "/api/me":
            return self._ok({"base_path": "/pikpak/Anime-Tracker"})
        if path == "/api/fs/get":
            full = "/pikpak/Anime-Tracker" + body["path"].rstrip("/")
            if full in self.dirs:
                return self._ok({"name": body["path"], "is_dir": True})
            return self._err(500, "failed get objs: failed get dir: object not found")
        if path == "/api/fs/mkdir":
            if self.mkdir_code != 200:
                return self._err(self.mkdir_code, "permission denied")
            self.dirs.add("/pikpak/Anime-Tracker" + body["path"])
            return self._ok(None)
        if path == "/api/fs/add_offline_download":
            task = {
                "id": f"task-{len(self.tasks) + 1}",
                "name": f"download {body['urls'][0]} to (/pikpak/Anime-Tracker{body['path']})",
                "state": 1,
                "start_time": f"2026-11-20T10:0{len(self.tasks)}:00Z",
                "total_bytes": 0,
            }
            self.tasks.append(task)
            return self._ok({"tasks": [task]})
        if path == "/api/task/offline_download/undone":
            return self._ok(self.tasks)
        if path == "/api/task/offline_download/done":
            return self._ok(self.done)
        if path == "/api/fs/list":
            return self._ok(
                {
                    "content": [
                        {
                            "name": "ep01.mkv",
                            "size": 100,
                            "is_dir": False,
                            "created": "2026-11-20T10:05:00+08:00",
                            "sign": "abc=:0",
                            "thumb": "https://thumb.example/1.jpg",
                        },
                        {
                            "name": "old",
                            "size": 0,
                            "is_dir": True,
                            "created": "0001-01-01T00:00:00Z",
                        },
                    ]
                }
            )
        return httpx.Response(404)

    @staticmethod
    def _ok(data: Any) -> httpx.Response:
        return httpx.Response(200, json={"code": 200, "message": "success", "data": data})

    @staticmethod
    def _err(code: int, message: str) -> httpx.Response:
        return httpx.Response(200, json={"code": code, "message": message, "data": None})


@pytest.fixture()
def fake() -> FakeOpenList:
    return FakeOpenList()


def _adapter(fake: FakeOpenList) -> OpenListAdapter:
    return OpenListAdapter(
        base_url="http://openlist:5244",
        public_url="https://list.example.com",
        username="ichat",
        password="pw",
        tool="PikPak",
        timeout=5,
        client=httpx.Client(transport=httpx.MockTransport(fake.handler)),
    )


def test_submit_creates_missing_dir_then_finds_task(fake: FakeOpenList) -> None:
    adapter = _adapter(fake)
    receipt = adapter.submit_offline(magnet=f"magnet:?xt=urn:btih:{HASH}", target_dir="/番/A")
    assert receipt.ref == {"id": "task-1"}
    assert "/pikpak/Anime-Tracker/番/A" in fake.dirs
    submit = next(body for path, body in fake.calls if path == "/api/fs/add_offline_download")
    assert submit["tool"] == "PikPak"
    assert submit["delete_policy"] == "delete_on_upload_succeed"

    assert adapter.find_existing(infohash=HASH, target_dir="/番/A") == {"id": "task-1"}
    assert adapter.find_existing(infohash=HASH, target_dir="/番/B") is None
    assert adapter.get_task({"id": "task-1"}).state == CloudTaskState.RUNNING
    assert adapter.get_task({"id": "gone"}).state == CloudTaskState.NOT_FOUND


def test_find_existing_ignores_failed_tasks_and_picks_latest(fake: FakeOpenList) -> None:
    name = f"download magnet:?xt=urn:btih:{HASH.upper()} to (/pikpak/Anime-Tracker/A)"
    fake.done = [
        {"id": "old", "name": name, "state": 2, "start_time": "2026-11-20T01:00:00Z"},
        {"id": "new", "name": name, "state": 2, "start_time": "2026-11-20T02:00:00Z"},
        {"id": "bad", "name": name, "state": 7, "start_time": "2026-11-20T03:00:00Z"},
    ]
    adapter = _adapter(fake)
    assert adapter.find_existing(infohash=HASH, target_dir="/A") == {"id": "new"}
    status = adapter.get_task({"id": "bad"})
    assert status.state == CloudTaskState.FAILED
    assert adapter.get_task({"id": "old"}).state == CloudTaskState.COMPLETED


def test_mkdir_permission_denied_is_permanent(fake: FakeOpenList) -> None:
    fake.mkdir_code = 403
    with pytest.raises(DriveError) as caught:
        _adapter(fake).submit_offline(magnet=f"magnet:?xt=urn:btih:{HASH}", target_dir="/X")
    assert not caught.value.transient


def test_relogin_once_after_token_invalidated(fake: FakeOpenList) -> None:
    adapter = _adapter(fake)
    adapter.list_dir("/")
    fake.token_valid = False
    adapter.list_dir("/")
    assert fake.logins == 2


def test_server_errors_are_transient() -> None:
    adapter = OpenListAdapter(
        base_url="http://openlist:5244",
        public_url="https://list.example.com",
        username="u",
        password="p",
        tool="PikPak",
        timeout=5,
        client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(502))),
    )
    with pytest.raises(DriveError) as caught:
        adapter.list_dir("/")
    assert caught.value.transient
    assert adapter.health().ok is False


def test_list_dir_and_play_links(fake: FakeOpenList) -> None:
    adapter = _adapter(fake)
    entries = adapter.list_dir("/番 A")
    assert entries[0].created == datetime(2026, 11, 20, 2, 5, tzinfo=UTC)
    assert entries[1].created is None  # zero time from folder entries
    links = adapter.play_links("/番 A", entries[0])
    encoded = "/pikpak/Anime-Tracker/%E7%95%AA%20A/ep01.mkv"
    assert links.file_page == f"https://list.example.com{encoded}"
    assert links.direct == f"https://list.example.com/d{encoded}?sign=abc=:0"
    no_sign = adapter.play_links("/番 A/ep01.mkv", None)
    assert no_sign.direct is None and no_sign.file_page.endswith("/ep01.mkv")


# --- Telegram -----------------------------------------------------------------


class FakeTelegram:
    def __init__(self, statuses: list[int]) -> None:
        self.statuses = statuses
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        status = self.statuses.pop(0) if self.statuses else 200
        return httpx.Response(status, json={"ok": status == 200, "description": "nope"})


def _notifier(fake: FakeTelegram) -> TelegramNotifier:
    return TelegramNotifier(
        token="123:secret",
        chat_id="42",
        client=httpx.Client(transport=httpx.MockTransport(fake.handler)),
    )


_INFO = ReleaseInfo(
    title="[A] Show - 01", series="Show <&>", episode=1, group="A", resolution="1080p"
)
_LINKS = PlayLinks(
    file_page="https://list.example.com/x/ep01.mkv",
    direct="https://list.example.com/d/x/ep01.mkv?sign=s",
)


def test_compose_completed_escapes_and_links_only_https() -> None:
    message = compose_completed(
        _INFO,
        size_bytes=300 * 1024 * 1024,
        links=_LINKS,
        located=True,
        file_count=1,
        photo=None,
        public_id="pid",
    )
    assert "Show &lt;&amp;&gt;" in message.html
    # Telegram drops non-http(s) link entities, so no player schemes.
    assert "://" not in message.html.replace("https://", "")
    assert f'<a href="{_LINKS.direct}">直链</a>' in message.html
    assert message.buttons == [Button("打开文件页", _LINKS.file_page)]
    assert "300.0 MB" in message.html


def test_compose_completed_without_file_mentions_it() -> None:
    message = compose_completed(
        _INFO, size_bytes=None, links=None, located=False, file_count=0, photo=None, public_id="p"
    )
    assert "未在目标目录定位到文件" in message.html
    assert message.buttons == []


def test_compose_failed_cloud_task_missing_lists_siblings() -> None:
    message = compose_failed(
        _INFO, status="failed", error="cloud_task_missing", public_id="p", skipped_siblings=["s1"]
    )
    assert "云端任务已不可查" in message.html and "<code>s1</code>" in message.html


def test_photo_uses_send_photo_with_caption() -> None:
    fake = FakeTelegram([200])
    _notifier(fake).send(Notification(html="<b>hi</b>", photo=b"jpg", buttons=[Button("a", "u")]))
    request = fake.requests[0]
    assert request.url.path.endswith("/sendPhoto")
    assert b'name="caption"' in request.content and b"<b>hi</b>" in request.content


def test_long_caption_falls_back_to_text_without_preview() -> None:
    fake = FakeTelegram([200])
    text = "x" * (CAPTION_LIMIT + 1)
    _notifier(fake).send(Notification(html=text, photo=b"jpg"))
    request = fake.requests[0]
    assert request.url.path.endswith("/sendMessage")
    payload = json.loads(request.content)
    assert payload["link_preview_options"] == {"is_disabled": True}
    assert visible_length("<a href='x'>&amp;</a>") == 1


def test_errors_are_classified_and_never_leak_token() -> None:
    with pytest.raises(NotifyError) as caught:
        _notifier(FakeTelegram([429])).send(Notification(html="x"))
    assert caught.value.retryable
    with pytest.raises(NotifyError) as caught:
        _notifier(FakeTelegram([400])).send(Notification(html="x"))
    assert not caught.value.retryable

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url}")

    notifier = TelegramNotifier(
        token="123:secret", chat_id="42", client=httpx.Client(transport=httpx.MockTransport(boom))
    )
    with pytest.raises(NotifyError) as caught:
        notifier.send(Notification(html="x"))
    assert "secret" not in str(caught.value) and caught.value.retryable


def test_dir_entry_type_is_frozen() -> None:
    entry = DirEntry("a", 1, False, None, "", "")
    with pytest.raises(AttributeError):
        entry.name = "b"  # type: ignore[misc]
