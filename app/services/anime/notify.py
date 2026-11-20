"""Telegram notifier and message composition (spec §7.6)."""

from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from app.services.anime.drive import PlayLinks

# The bot token is part of the request path; httpx logs full URLs at INFO and
# Celery raises the root logger to INFO, so the httpx logger stays at WARNING.
logging.getLogger("httpx").setLevel(logging.WARNING)

TELEGRAM_API_BASE = "https://api.telegram.org"
CAPTION_LIMIT = 1024
MESSAGE_LIMIT = 4096
THUMB_MAX_BYTES = 5 * 1024 * 1024
THUMB_TIMEOUT_SECONDS = 10.0
_TAG = re.compile(r"<[^>]+>")


class NotifyError(Exception):
    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


@dataclass(frozen=True)
class Button:
    text: str
    url: str


@dataclass(frozen=True)
class Notification:
    html: str
    buttons: list[Button] = field(default_factory=list)
    photo: bytes | None = None


class Notifier(Protocol):
    def send(self, notification: Notification) -> None: ...


def visible_length(markup: str) -> int:
    """Length Telegram counts for an HTML message: tags removed, entities decoded."""
    return len(html.unescape(_TAG.sub("", markup)))


class TelegramNotifier:
    def __init__(
        self,
        *,
        token: str,
        chat_id: str,
        timeout: float = 15.0,
        client: httpx.Client | None = None,
        api_base: str = TELEGRAM_API_BASE,
    ) -> None:
        self._token = token
        self._chat_id = chat_id
        self._timeout = timeout
        self._client = client or httpx.Client()
        self._api_base = api_base.rstrip("/")

    def send(self, notification: Notification) -> None:
        text = notification.html
        markup = _reply_markup(notification.buttons)
        if notification.photo is not None and visible_length(text) <= CAPTION_LIMIT:
            data: dict[str, Any] = {
                "chat_id": self._chat_id,
                "caption": text,
                "parse_mode": "HTML",
            }
            if markup:
                data["reply_markup"] = markup
            self._post(
                "sendPhoto",
                data=data,
                files={"photo": ("thumb.jpg", notification.photo, "image/jpeg")},
            )
            return
        payload: dict[str, Any] = {
            "chat_id": self._chat_id,
            "text": text,
            "parse_mode": "HTML",
            # A preview would make Telegram fetch the signed direct link.
            "link_preview_options": {"is_disabled": True},
        }
        if markup:
            payload["reply_markup"] = markup
        self._post("sendMessage", json=payload)

    def _post(self, method: str, **kwargs: Any) -> None:
        url = f"{self._api_base}/bot{self._token}/{method}"
        try:
            response = self._client.post(url, timeout=self._timeout, **kwargs)
        except httpx.HTTPError as exc:
            # Never include the exception text: it can carry the token URL.
            raise NotifyError(f"telegram {method}: {type(exc).__name__}", retryable=True) from None
        if response.status_code == 200:
            return
        description = ""
        try:
            description = str(response.json().get("description") or "")[:200]
        except ValueError:
            pass
        retryable = response.status_code == 429 or response.status_code >= 500
        raise NotifyError(
            f"telegram {method}: HTTP {response.status_code} {description}".strip(),
            retryable=retryable,
            status=response.status_code,
        )


def _reply_markup(buttons: list[Button]) -> str | None:
    if not buttons:
        return None
    return json.dumps({"inline_keyboard": [[{"text": b.text, "url": b.url}] for b in buttons]})


def download_thumb(client: httpx.Client, url: str) -> bytes | None:
    """Fetch a PikPak thumbnail; any failure degrades to a text notification."""
    if not url.startswith(("https://", "http://")):
        return None
    try:
        with client.stream(
            "GET", url, timeout=THUMB_TIMEOUT_SECONDS, follow_redirects=True
        ) as response:
            if response.status_code != 200:
                return None
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > THUMB_MAX_BYTES:
                    return None
                chunks.append(chunk)
    except httpx.HTTPError:
        return None
    body = b"".join(chunks)
    return body or None


# --- composition -------------------------------------------------------------


@dataclass(frozen=True)
class ReleaseInfo:
    title: str
    series: str | None
    episode: int | None
    group: str | None
    resolution: str | None


def _e(value: object) -> str:
    return html.escape(str(value), quote=True)


def _headline(info: ReleaseInfo) -> str:
    name = info.series or info.title
    episode = f" 第 {info.episode} 集" if info.episode is not None else ""
    return f"{_e(name)}{_e(episode)}"


def _details(info: ReleaseInfo, size_bytes: int | None) -> list[str]:
    lines = []
    meta = " · ".join(_e(v) for v in (info.group, info.resolution) if v)
    if meta:
        lines.append(meta)
    if size_bytes:
        lines.append(f"大小：{_e(_human_size(size_bytes))}")
    return lines


def compose_completed(
    info: ReleaseInfo,
    *,
    size_bytes: int | None,
    links: PlayLinks | None,
    located: bool,
    file_count: int,
    photo: bytes | None,
    public_id: str,
) -> Notification:
    head = [f"✅ <b>{_headline(info)}</b> 已下载完成", *_details(info, size_bytes)]
    if file_count > 1:
        head.append(f"共 {file_count} 个文件，链接为第一个视频")
    if not located:
        head.append("未在目标目录定位到文件，请在 OpenList 中核对")
    tail = [f"<code>{_e(public_id)}</code>"]
    if links is not None and links.direct:
        tail.insert(0, f'<a href="{_e(links.direct)}">直链</a>')
    # No player scheme links: Telegram silently drops non-http(s) link
    # entities, leaving dead text (verified 2026-11-20).
    buttons = [Button("打开文件页", links.file_page)] if links else []
    return Notification(html="\n".join([*head, *tail]), buttons=buttons, photo=photo)


def compose_failed(
    info: ReleaseInfo,
    *,
    status: str,
    error: str | None,
    public_id: str,
    skipped_siblings: list[str],
) -> Notification:
    if error == "cloud_task_missing":
        reason = "云端任务已不可查，文件可能已在目录中，请核对"
    else:
        reason = f"原因：{_e((error or status)[:300])}"
    lines = [f"❌ <b>{_headline(info)}</b> 下载失败", reason]
    if skipped_siblings:
        lines.append("同集被跳过的资源（可 downloads retry 补位）：")
        lines.extend(f"<code>{_e(item)}</code>" for item in skipped_siblings[:5])
    lines.append(f"<code>{_e(public_id)}</code>")
    return Notification(html="\n".join(lines))


def compose_alert(key: str, status: str, error: str | None) -> Notification:
    target = "OpenList / PikPak" if key == "drive" else f"订阅源 {key.removeprefix('feed:')}"
    if status == "ok":
        return Notification(html=f"🟢 <b>{_e(target)}</b> 已恢复")
    detail = f"\n{_e(error[:300])}" if error else ""
    word = "不可用" if status == "down" else "连续拉取失败"
    return Notification(html=f"🔴 <b>{_e(target)}</b> {word}{detail}")


def compose_notice(text: str) -> Notification:
    return Notification(html=_e(text))


def _human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit in ("B", "KB") else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"
