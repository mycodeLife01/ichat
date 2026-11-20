"""Rule-based release title parser (P0).

Pure function from an untrusted fansub title to the ``parsed`` fields of
``anime_releases``. Unparsable fields are ``None``; parsing never blocks a
download. P1 compares this against an LLM parser on the same interface.
"""

from __future__ import annotations

import html
import re
from typing import Any

PARSER = "regex"
PARSER_VERSION = 1

_LEADING_GROUP = re.compile(r"^\s*[\[【]([^\]】]+)[\]】]")
_LEADING_BRACKETS = re.compile(r"^(?:\s*[\[【][^\]】]*[\]】])+")
_FIRST_BRACKET = re.compile(r"[\[【]([^\]】]+)[\]】]")
_DECORATION = re.compile(r"★[^★]{0,20}★")
_YEAR = re.compile(r"\((?:19|20)\d{2}\)")

_RANGE = re.compile(r"(?:[\[【]|\s-\s)\s*(?:第)?(\d{1,4})\s*[-~～]\s*(\d{1,4})(?:\s*[话話集])?")
_EPISODE_PATTERNS = (
    re.compile(r"第\s*(\d{1,4})\s*[话話集]"),
    re.compile(r"\bS\d{1,2}E(\d{1,4})\b", re.IGNORECASE),
    re.compile(r"\s-\s(\d{1,4})(?:v\d)?(?=$|[\s\[(【])"),
    re.compile(r"[\[【](\d{1,4})(?:v\d)?[\]】]"),
)
_BATCH_WORDS = re.compile(r"合集|全集|Batch|\bComplete\b", re.IGNORECASE)
_FIN = re.compile(r"\bFin\b|\[完\]|完结", re.IGNORECASE)

_RESOLUTION_P = re.compile(r"(?<!\d)(480|540|720|1080|1440|2160)[pP](?![a-zA-Z])")
_RESOLUTION_WXH = re.compile(r"(?<!\d)(?:\d{3,4})[xX×](480|540|720|1080|1440|2160)(?!\d)")
_RESOLUTION_4K = re.compile(r"\b4K\b", re.IGNORECASE)

_CHS = re.compile(r"简|CHS|\bGB\b|SC(?![a-zA-Z])", re.IGNORECASE)
_CHT = re.compile(r"繁|CHT|BIG5|TC(?![a-zA-Z])", re.IGNORECASE)
_SUBTITLE_SCOPE = re.compile(r"[\[【(（][^\]】)）]*[\]】)）]")


def parse_title(raw_title: str) -> dict[str, Any]:
    title = " ".join(html.unescape(raw_title).split())
    result: dict[str, Any] = {
        "series": None,
        "episode": None,
        "group": None,
        "resolution": None,
        "subtitle_lang": None,
        "is_batch": False,
        "parser": PARSER,
        "parser_version": PARSER_VERSION,
    }

    rest = title
    group_match = _LEADING_GROUP.match(title)
    if group_match:
        result["group"] = group_match.group(1).strip() or None
        rest = title[group_match.end() :]
    rest = _DECORATION.sub(" ", rest)

    range_match = _RANGE.search(rest)
    episode_match = None
    if range_match is None:
        for pattern in _EPISODE_PATTERNS:
            episode_match = pattern.search(rest)
            if episode_match:
                break

    is_batch = range_match is not None or bool(_BATCH_WORDS.search(rest))
    if episode_match is None and range_match is None and _FIN.search(rest):
        is_batch = True
    result["is_batch"] = is_batch
    if episode_match is not None and not is_batch:
        result["episode"] = int(episode_match.group(1))

    marker = range_match or episode_match
    head = rest[: marker.start()] if marker else _before_metadata(rest)
    result["series"] = _series_from_head(head)
    result["resolution"] = _resolution(title)
    result["subtitle_lang"] = _subtitle_lang(rest)
    return result


def _before_metadata(rest: str) -> str:
    stripped = _LEADING_BRACKETS.sub("", rest)
    if stripped.strip():
        offset = len(rest) - len(stripped)
        cut = re.search(r"[\[【(]", stripped)
        return rest[: offset + cut.start()] if cut else rest
    return rest


def _series_from_head(head: str) -> str | None:
    # The episode marker may sit inside a bracket ("[第28话]"), leaving its
    # opening bracket on the head; a range may sit inside the series bracket.
    text = re.sub(r"[\s\[【(（]+$", "", head)
    stripped = _LEADING_BRACKETS.sub("", text).strip()
    if stripped[:1] in {"[", "【"} and not re.search(r"[\]】]", stripped):
        stripped = stripped[1:]
    if not stripped:
        first = _FIRST_BRACKET.search(text)
        stripped = first.group(1) if first else ""
    stripped = _YEAR.sub(" ", stripped)
    primary = stripped.split("/", 1)[0]
    if "_" in primary and re.search(r"[぀-ヿ一-鿿]", primary.split("_", 1)[0]):
        primary = primary.split("_", 1)[0]
    primary = re.sub(r"[\[【].*$", "", primary)
    series = " ".join(primary.split()).strip(" -_")
    return series or None


def _resolution(title: str) -> str | None:
    match = _RESOLUTION_P.search(title) or _RESOLUTION_WXH.search(title)
    if match:
        return f"{match.group(1)}p"
    if _RESOLUTION_4K.search(title):
        return "2160p"
    return None


def _subtitle_lang(rest: str) -> str | None:
    # Only bracketed metadata, so a series name containing 简/繁 is ignored.
    scope = " ".join(_SUBTITLE_SCOPE.findall(rest))
    langs = []
    if _CHS.search(scope):
        langs.append("chs")
    if _CHT.search(scope):
        langs.append("cht")
    return "+".join(langs) or None
