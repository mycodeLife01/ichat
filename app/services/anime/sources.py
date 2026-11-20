"""Mikan RSS fetching and item normalization."""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from app.services.anime.infohash import InvalidInfohash, infohash_from_url

MAX_FEED_BYTES = 5 * 1024 * 1024
_MIKAN_NS = "{https://mikanani.me/0.1/}"
# Mikan pubDate has no offset and is Beijing time (S0-5); China has no DST,
# so a fixed offset avoids depending on tzdata in the image.
_MIKAN_TZ = timezone(timedelta(hours=8))


class FeedFetchError(Exception):
    pass


@dataclass(frozen=True)
class FeedItem:
    infohash: str
    title: str
    source_url: str | None
    torrent_url: str | None
    size_bytes: int | None
    published_at: datetime | None


def redact_url(url: str) -> str:
    """Hide query values: Mikan personal RSS URLs carry a token."""
    parts = urlsplit(url)
    if not parts.query:
        return url
    query = urlencode([(key, "***") for key, _ in parse_qsl(parts.query, keep_blank_values=True)])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def fetch_feed(client: httpx.Client, url: str, *, timeout: float = 15.0) -> bytes:
    # Mikan sends no ETag/Last-Modified, so this is a plain GET (S0-5).
    try:
        with client.stream("GET", url, timeout=timeout, follow_redirects=True) as response:
            if response.status_code != 200:
                raise FeedFetchError(f"HTTP {response.status_code}")
            chunks: list[bytes] = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_FEED_BYTES:
                    raise FeedFetchError("feed body too large")
                chunks.append(chunk)
            return b"".join(chunks)
    except httpx.HTTPError as exc:
        # The exception text may contain the URL; keep only the class name.
        raise FeedFetchError(type(exc).__name__) from None


def parse_mikan_rss(body: bytes) -> list[FeedItem]:
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise FeedFetchError(f"invalid RSS: {exc}") from None
    items: list[FeedItem] = []
    for item in root.iter("item"):
        title = _text(item, "title")
        link = _text(item, "link")
        enclosure = item.find("enclosure")
        torrent_url = enclosure.get("url") if enclosure is not None else None
        infohash = _first_infohash(torrent_url, link)
        if infohash is None or not title:
            continue
        torrent = item.find(f"{_MIKAN_NS}torrent")
        size = _int(enclosure.get("length") if enclosure is not None else None)
        published = None
        if torrent is not None:
            size = _int(_text(torrent, f"{_MIKAN_NS}contentLength")) or size
            published = _mikan_time(_text(torrent, f"{_MIKAN_NS}pubDate"))
        items.append(
            FeedItem(
                infohash=infohash,
                title=html.unescape(title).strip(),
                source_url=link,
                torrent_url=torrent_url,
                size_bytes=size,
                published_at=published,
            )
        )
    return items


def _text(node: ET.Element, tag: str) -> str | None:
    child = node.find(tag)
    if child is None or child.text is None:
        return None
    return child.text.strip() or None


def _first_infohash(*urls: str | None) -> str | None:
    for url in urls:
        if not url:
            continue
        try:
            return infohash_from_url(url)
        except InvalidInfohash:
            continue
    return None


def _int(value: str | None) -> int | None:
    if value is None or not re.fullmatch(r"\d{1,19}", value.strip()):
        return None
    return int(value)


def _mikan_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_MIKAN_TZ)
