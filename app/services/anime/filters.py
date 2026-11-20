"""Feed filter rules (spec §7.2): validation on write, evaluation on poll.

``episode_dedupe`` and the backfill window need the database and are applied
by ``feeds``; this module owns the pure title rules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

MAX_PATTERNS = 20
MAX_PATTERN_LENGTH = 200
DEFAULT_FILTERS: dict[str, Any] = {
    "include": [],
    "exclude": [],
    "skip_batch": True,
    "episode_dedupe": True,
    "backfill_hours": 24,
}
_KEYS = set(DEFAULT_FILTERS)


class InvalidFilters(ValueError):
    pass


@dataclass(frozen=True)
class FeedFilters:
    include: tuple[re.Pattern[str], ...]
    exclude: tuple[re.Pattern[str], ...]
    skip_batch: bool
    episode_dedupe: bool
    backfill_hours: int


def validate_filters(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a complete, normalized filter document or raise."""
    unknown = set(raw) - _KEYS
    if unknown:
        raise InvalidFilters(f"unknown filter keys: {', '.join(sorted(unknown))}")
    merged = {**DEFAULT_FILTERS, **raw}
    for key in ("include", "exclude"):
        patterns = merged[key]
        if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
            raise InvalidFilters(f"{key} must be a list of strings")
        if len(patterns) > MAX_PATTERNS:
            raise InvalidFilters(f"{key} allows at most {MAX_PATTERNS} patterns")
        for pattern in patterns:
            if not pattern or len(pattern) > MAX_PATTERN_LENGTH:
                raise InvalidFilters(f"{key} patterns must be 1-{MAX_PATTERN_LENGTH} chars")
            try:
                re.compile(pattern, re.IGNORECASE)
            except re.error as exc:
                raise InvalidFilters(f"invalid {key} pattern {pattern!r}: {exc}") from None
    for key in ("skip_batch", "episode_dedupe"):
        if not isinstance(merged[key], bool):
            raise InvalidFilters(f"{key} must be a boolean")
    hours = merged["backfill_hours"]
    if isinstance(hours, bool) or not isinstance(hours, int) or hours < 0:
        raise InvalidFilters("backfill_hours must be a non-negative integer")
    return merged


def compile_filters(raw: dict[str, Any]) -> FeedFilters:
    doc = validate_filters(raw)
    return FeedFilters(
        include=tuple(re.compile(p, re.IGNORECASE) for p in doc["include"]),
        exclude=tuple(re.compile(p, re.IGNORECASE) for p in doc["exclude"]),
        skip_batch=doc["skip_batch"],
        episode_dedupe=doc["episode_dedupe"],
        backfill_hours=doc["backfill_hours"],
    )


def title_skip_reason(filters: FeedFilters, title: str, parsed: dict[str, Any]) -> str | None:
    """Return why a release is skipped by the title rules, or None to accept."""
    if filters.include and not all(p.search(title) for p in filters.include):
        return "include"
    if any(p.search(title) for p in filters.exclude):
        return "exclude"
    if filters.skip_batch and parsed.get("is_batch"):
        return "batch"
    return None
