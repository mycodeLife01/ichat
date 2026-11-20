"""Anime tracking domain: Mikan RSS -> OpenList/PikPak -> Telegram (P0).

``services/anime`` is the only business owner of feeds, releases, downloads
and integration health. Celery tasks and the operator CLI call the functions
below instead of re-implementing state transitions.
"""

from __future__ import annotations

from functools import lru_cache

import httpx

from app.core.config import Settings
from app.services.anime.notify import TelegramNotifier
from app.services.anime.openlist import OpenListAdapter
from app.services.anime.sources import fetch_feed

FEED_TIMEOUT_SECONDS = 15.0


def build_drive_adapter(settings: Settings) -> OpenListAdapter:
    return OpenListAdapter(
        base_url=settings.openlist_base_url,
        public_url=settings.openlist_public_url,
        username=settings.openlist_username,
        password=settings.openlist_password,
        tool=settings.openlist_offline_tool,
        timeout=settings.anime_drive_call_timeout_seconds,
    )


def build_notifier(settings: Settings) -> TelegramNotifier:
    return TelegramNotifier(token=settings.telegram_bot_token, chat_id=settings.telegram_chat_id)


@lru_cache
def http_client() -> httpx.Client:
    """Per-process client for RSS and thumbnail fetches (created after fork)."""
    return httpx.Client(headers={"User-Agent": "ichat-anime/1.0"})


def fetch_feed_body(url: str) -> bytes:
    return fetch_feed(http_client(), url, timeout=FEED_TIMEOUT_SECONDS)
