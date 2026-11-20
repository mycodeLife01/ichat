"""OpenList HTTP API adapter (spec §5.2, facts verified against v4.2.10)."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx

from app.services.anime.drive import (
    CloudTaskRef,
    CloudTaskState,
    CloudTaskStatus,
    DirEntry,
    DriveError,
    DriveErrorKind,
    DriveHealth,
    PlayLinks,
    SubmitReceipt,
    join_path,
)
from app.services.anime.infohash import InvalidInfohash, infohash_from_magnet

# OpenList task states (tache): only these two are terminal failures.
_FAILED_STATES = {4, 7}  # canceled, failed
_SUCCEEDED_STATE = 2
_TASK_NAME = re.compile(r"^download (\S+) to \((.*)\)$")
_TRANSIENT, _PERMANENT = DriveErrorKind.TRANSIENT, DriveErrorKind.PERMANENT


class OpenListAdapter:
    def __init__(
        self,
        *,
        base_url: str,
        public_url: str,
        username: str,
        password: str,
        tool: str,
        timeout: float,
        client: httpx.Client | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._public_url = public_url.rstrip("/")
        self._username = username
        self._password = password
        self._tool = tool
        self._timeout = timeout
        self._client = client or httpx.Client()
        self._token: str | None = None
        self._base_path: str | None = None

    # --- protocol ---------------------------------------------------------

    def submit_offline(self, *, magnet: str, target_dir: str) -> SubmitReceipt:
        self._ensure_dir(target_dir)
        data = self._call(
            "POST",
            "/api/fs/add_offline_download",
            json={
                "path": target_dir,
                "urls": [magnet],
                "tool": self._tool,
                "delete_policy": "delete_on_upload_succeed",
            },
        )
        tasks = (data or {}).get("tasks") or []
        if not tasks or not tasks[0].get("id"):
            raise DriveError(_TRANSIENT, "offline download response has no task id")
        return SubmitReceipt(ref={"id": str(tasks[0]["id"])})

    def get_task(self, ref: CloudTaskRef) -> CloudTaskStatus:
        task_id = ref.get("id")
        for task in self._all_tasks():
            if str(task.get("id")) == task_id:
                return _task_status(task)
        # OpenList keeps tasks only in memory; a restart drops them (S0-6).
        return CloudTaskStatus(CloudTaskState.NOT_FOUND)

    def find_existing(self, *, infohash: str, target_dir: str) -> CloudTaskRef | None:
        wanted_dir = join_path(self._ensure_base_path(), target_dir)
        best: dict[str, Any] | None = None
        for task in self._all_tasks():
            if task.get("state") in _FAILED_STATES:
                continue
            match = _TASK_NAME.match(str(task.get("name") or ""))
            if match is None:
                continue
            try:
                task_hash = infohash_from_magnet(match.group(1))
            except InvalidInfohash:
                continue
            if task_hash != infohash or join_path(match.group(2)) != wanted_dir:
                continue
            if best is None or str(task.get("start_time") or "") >= str(
                best.get("start_time") or ""
            ):
                best = task
        return {"id": str(best["id"])} if best else None

    def list_dir(self, path: str) -> list[DirEntry]:
        data = self._call(
            "POST",
            "/api/fs/list",
            json={"path": path, "password": "", "page": 1, "per_page": 0, "refresh": False},
        )
        return [_dir_entry(item) for item in ((data or {}).get("content") or [])]

    def health(self) -> DriveHealth:
        try:
            self._ensure_base_path()
            self.list_dir("/")
        except DriveError as exc:
            return DriveHealth(ok=False, error=str(exc))
        return DriveHealth(ok=True)

    def play_links(self, path: str, entry: DirEntry | None) -> PlayLinks:
        absolute = join_path(self._ensure_base_path(), path, entry.name if entry else "")
        encoded = "/".join(quote(segment, safe="") for segment in absolute.split("/"))
        # The file page is opened with the owner's own account, whose base
        # path is the drive root, so it uses the storage absolute path too.
        file_page = f"{self._public_url}{encoded}"
        if entry is None or not entry.sign:
            return PlayLinks(file_page, None)
        direct = f"{self._public_url}/d{encoded}?sign={quote(entry.sign, safe='=:')}"
        return PlayLinks(file_page=file_page, direct=direct)

    # --- internals ----------------------------------------------------------

    def _ensure_dir(self, path: str) -> None:
        try:
            self._call("POST", "/api/fs/get", json={"path": path, "password": ""})
            return
        except DriveError as exc:
            if "not found" not in str(exc):
                raise
        # Requires the "create directory" permission on the OpenList user.
        self._call("POST", "/api/fs/mkdir", json={"path": path})

    def _all_tasks(self) -> list[dict[str, Any]]:
        tasks: list[dict[str, Any]] = []
        for kind in ("undone", "done"):
            tasks.extend(self._call("GET", f"/api/task/offline_download/{kind}") or [])
        return tasks

    def _ensure_base_path(self) -> str:
        if self._base_path is None:
            me = self._call("GET", "/api/me") or {}
            self._base_path = str(me.get("base_path") or "/")
        return self._base_path

    def _login(self) -> None:
        body = self._send(
            "POST",
            "/api/auth/login",
            json={"username": self._username, "password": self._password},
            token=None,
        )
        code = body.get("code")
        token = (body.get("data") or {}).get("token")
        if code != 200 or not token:
            kind = _TRANSIENT if code in (429, 500) else _PERMANENT
            raise DriveError(kind, f"login failed: {body.get('message')}")
        self._token = str(token)

    def _call(self, method: str, path: str, *, json: Any = None) -> Any:
        for attempt in range(2):
            if self._token is None:
                self._login()
            body = self._send(method, path, json=json, token=self._token)
            code = body.get("code")
            if code == 200:
                return body.get("data")
            message = str(body.get("message") or "")
            if code == 401 and attempt == 0:
                # Tokens are invalidated by an OpenList restart (S0-6).
                self._token = None
                self._base_path = None
                continue
            raise DriveError(_classify(code, message), f"{path}: {code} {message}")
        raise DriveError(_TRANSIENT, f"{path}: unauthorized after re-login")

    def _send(self, method: str, path: str, *, json: Any, token: str | None) -> dict[str, Any]:
        headers = {"Authorization": token} if token else {}
        try:
            response = self._client.request(
                method, f"{self._base_url}{path}", json=json, headers=headers, timeout=self._timeout
            )
        except httpx.HTTPError as exc:
            raise DriveError(_TRANSIENT, f"{path}: {type(exc).__name__}") from None
        if response.status_code >= 500 or response.status_code == 429:
            raise DriveError(_TRANSIENT, f"{path}: HTTP {response.status_code}")
        if response.status_code == 401:
            return {"code": 401, "message": "unauthorized"}
        if response.status_code != 200:
            raise DriveError(_PERMANENT, f"{path}: HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError:
            raise DriveError(_TRANSIENT, f"{path}: invalid JSON response") from None
        if not isinstance(body, dict):
            raise DriveError(_TRANSIENT, f"{path}: unexpected response shape")
        return body


def _classify(code: Any, message: str) -> DriveErrorKind:
    # OpenList answers HTTP 200 with the real status in the body.
    if code in (400, 403, 404) or "not found" in message:
        return _PERMANENT
    return _TRANSIENT


def _task_status(task: dict[str, Any]) -> CloudTaskStatus:
    state = task.get("state")
    total = task.get("total_bytes")
    total_bytes = int(total) if isinstance(total, int) and total > 0 else None
    if state == _SUCCEEDED_STATE:
        return CloudTaskStatus(CloudTaskState.COMPLETED, total_bytes)
    if state in _FAILED_STATES:
        return CloudTaskStatus(
            CloudTaskState.FAILED, total_bytes, str(task.get("error") or "") or None
        )
    return CloudTaskStatus(CloudTaskState.RUNNING, total_bytes)


def _dir_entry(item: dict[str, Any]) -> DirEntry:
    return DirEntry(
        name=str(item.get("name") or ""),
        size=int(item.get("size") or 0),
        is_dir=bool(item.get("is_dir")),
        created=_parse_time(item.get("created")),
        sign=str(item.get("sign") or ""),
        thumb=str(item.get("thumb") or ""),
    )


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.year < 2000 or parsed.tzinfo is None:
        return None
    return parsed
