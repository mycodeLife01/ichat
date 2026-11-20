"""Infohash normalization for magnets, torrent URLs and Mikan page links."""

from __future__ import annotations

import base64
import re
from urllib.parse import parse_qs, urlsplit

_HEX40 = re.compile(r"[0-9a-fA-F]{40}")
_BASE32 = re.compile(r"[A-Za-z2-7]{32}")


class InvalidInfohash(ValueError):
    pass


def normalize_infohash(value: str) -> str:
    """Return lowercase hex; base32 btih values are converted."""
    candidate = value.strip()
    if _HEX40.fullmatch(candidate):
        return candidate.lower()
    if _BASE32.fullmatch(candidate):
        return base64.b32decode(candidate.upper()).hex()
    raise InvalidInfohash("not a v1 BitTorrent infohash")


def infohash_from_magnet(magnet: str) -> str:
    parts = urlsplit(magnet.strip())
    if parts.scheme.lower() != "magnet":
        raise InvalidInfohash("not a magnet link")
    for xt in parse_qs(parts.query).get("xt", []):
        if xt.lower().startswith("urn:btih:"):
            return normalize_infohash(xt[len("urn:btih:") :])
    raise InvalidInfohash("magnet has no btih")


def infohash_from_url(url: str) -> str:
    """Extract the 40-hex hash from the last path segment of a Mikan URL.

    Mikan items carry no magnet; both ``/Download/{date}/{hash}.torrent`` and
    ``/Home/Episode/{hash}`` end in the real infohash (verified in S0-5).
    """
    segment = urlsplit(url.strip()).path.rstrip("/").rsplit("/", 1)[-1]
    stem = segment.removesuffix(".torrent")
    if not _HEX40.fullmatch(stem):
        raise InvalidInfohash("URL does not end in an infohash")
    return stem.lower()


def magnet_for(infohash: str) -> str:
    # A bare btih magnet downloads fine through PikPak (S0-2).
    return f"magnet:?xt=urn:btih:{normalize_infohash(infohash)}"
