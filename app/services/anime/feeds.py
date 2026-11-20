"""Feed claim and polling (spec §7.1, §7.2).

Fetching happens outside any transaction; releases, downloads and the feed
schedule are then written in one transaction, idempotent on infohash.
"""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from loguru import logger
from sqlalchemy import Integer, and_, cast, exists, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, sessionmaker

from app.models.anime import AnimeDownload, AnimeFeed, AnimeRelease
from app.services.anime.drive import join_path
from app.services.anime.filters import compile_filters, title_skip_reason
from app.services.anime.health import feed_key, record_state
from app.services.anime.infohash import magnet_for
from app.services.anime.parsing import parse_title
from app.services.anime.sources import FeedFetchError, FeedItem, parse_mikan_rss, redact_url

POLL_LEASE_SECONDS = 120
FAILURE_BACKOFF_SECONDS = (60, 300, 900, 3600, 21600)
FAILING_THRESHOLD = 5
UNCATEGORIZED_DIR = "Unsorted"
# A later release of an episode is skipped while one of these exists.
DEDUPE_BLOCKING_STATUSES = ("pending", "submitting", "running", "completed")
_MAX_ERROR_LEN = 1000
_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


@dataclass
class PollResult:
    feed_id: int
    fetched: bool = False
    items: int = 0
    new_releases: int = 0
    new_downloads: list[uuid.UUID] = field(default_factory=list)
    error: str | None = None


def safe_dir_name(name: str | None) -> str:
    if not name:
        return UNCATEGORIZED_DIR
    cleaned = " ".join(_UNSAFE_NAME.sub(" ", name).split()).strip(" .")
    return cleaned[:80].strip(" .") or UNCATEGORIZED_DIR


def claim_due_feeds(session: Session, *, now: datetime | None = None) -> list[int]:
    """Lease due feeds; the lease only reduces duplicate fetches."""
    moment = now or datetime.now(UTC)
    feeds = session.scalars(
        select(AnimeFeed)
        .where(
            AnimeFeed.enabled.is_(True),
            AnimeFeed.next_poll_at <= moment,
            or_(AnimeFeed.lease_expires_at.is_(None), AnimeFeed.lease_expires_at < moment),
        )
        .with_for_update(skip_locked=True)
    ).all()
    for feed in feeds:
        feed.lease_expires_at = moment + timedelta(seconds=POLL_LEASE_SECONDS)
    return [feed.id for feed in feeds]


def poll_feed(
    factory: sessionmaker[Session],
    feed_id: int,
    *,
    fetch: Callable[[str], bytes],
    storage_root: str,
    now: datetime | None = None,
) -> PollResult:
    result = PollResult(feed_id=feed_id)
    with factory() as session:
        feed = session.get(AnimeFeed, feed_id)
        if feed is None:
            return result
        url, enabled = feed.url, feed.enabled
    if not enabled:
        with factory() as session:
            session.execute(
                update(AnimeFeed).where(AnimeFeed.id == feed_id).values(lease_expires_at=None)
            )
            session.commit()
        return result

    started = time.monotonic()
    try:
        items = parse_mikan_rss(fetch(url))
    except FeedFetchError as exc:
        result.error = str(exc)
        _record_failure(factory, feed_id, error=result.error, now=now or datetime.now(UTC))
        logger.bind(
            event="anime_feed_polled", feed_id=feed_id, url=redact_url(url), ok=False
        ).warning(f"anime feed poll failed: {result.error}")
        return result

    result.fetched = True
    result.items = len(items)
    moment = now or datetime.now(UTC)
    with factory() as session:
        feed = session.get(AnimeFeed, feed_id, with_for_update=True)
        if feed is None:
            return result
        _ingest(session, feed, items, result, storage_root=storage_root)
        feed.last_polled_at = moment
        feed.next_poll_at = moment + timedelta(seconds=feed.poll_interval_seconds)
        feed.lease_expires_at = None
        feed.consecutive_failures = 0
        feed.last_error = None
        record_state(session, key=feed_key(feed_id), status="ok", error=None, now=moment)
        session.commit()
    logger.bind(
        event="anime_feed_polled",
        feed_id=feed_id,
        ok=True,
        items=result.items,
        new_releases=result.new_releases,
        new_downloads=len(result.new_downloads),
        elapsed_ms=round((time.monotonic() - started) * 1000),
    ).info("anime feed polled")
    return result


def _ingest(
    session: Session,
    feed: AnimeFeed,
    items: list[FeedItem],
    result: PollResult,
    *,
    storage_root: str,
) -> None:
    filters = compile_filters(feed.filters)
    backfill_floor = feed.created_at - timedelta(hours=filters.backfill_hours)
    # Oldest first, so the earliest version of an episode wins the dedupe.
    ordered = sorted(items, key=lambda item: item.published_at or datetime.min.replace(tzinfo=UTC))
    for item in ordered:
        parsed = parse_title(item.title)
        inserted = session.scalar(
            insert(AnimeRelease)
            .values(
                infohash=item.infohash,
                title=item.title,
                source=feed.source,
                source_url=item.source_url,
                torrent_url=item.torrent_url,
                # Items without an enclosure still need a locator.
                magnet=None if item.torrent_url else magnet_for(item.infohash),
                size_bytes=item.size_bytes,
                published_at=item.published_at,
                parsed=parsed,
            )
            .on_conflict_do_nothing(index_elements=["infohash"])
            .returning(AnimeRelease.id)
        )
        if inserted is not None:
            result.new_releases += 1

        reason = title_skip_reason(filters, item.title, parsed)
        if reason is None and item.published_at is not None and item.published_at < backfill_floor:
            reason = "backfill"
        if reason is None and filters.episode_dedupe and _episode_taken(session, parsed):
            reason = "episode_dedupe"
        target_dir = join_path(storage_root, feed.target_dir, safe_dir_name(parsed["series"]))
        status = "skipped" if reason else "pending"
        public_id = session.scalar(
            insert(AnimeDownload)
            .values(
                infohash=item.infohash,
                origin="feed",
                feed_id=feed.id,
                target_dir=target_dir,
                status=status,
                skip_reason=reason,
            )
            .on_conflict_do_nothing(index_elements=["infohash"])
            .returning(AnimeDownload.public_id)
        )
        if public_id is not None and status == "pending":
            result.new_downloads.append(public_id)


def _episode_taken(session: Session, parsed: dict[str, object]) -> bool:
    series, episode = parsed.get("series"), parsed.get("episode")
    if not series or episode is None or parsed.get("is_batch"):
        return False
    # Check-then-insert without a constraint: a rare concurrent duplicate across
    # feeds is accepted (spec §7.2).
    return bool(
        session.scalar(
            select(
                exists().where(
                    and_(
                        AnimeDownload.infohash == AnimeRelease.infohash,
                        AnimeDownload.status.in_(DEDUPE_BLOCKING_STATUSES),
                        AnimeRelease.parsed["series"].astext == series,
                        cast(AnimeRelease.parsed["episode"].astext, Integer) == episode,
                    )
                )
            )
        )
    )


def _record_failure(
    factory: sessionmaker[Session], feed_id: int, *, error: str, now: datetime
) -> None:
    with factory() as session:
        feed = session.get(AnimeFeed, feed_id, with_for_update=True)
        if feed is None:
            return
        feed.consecutive_failures += 1
        feed.last_error = error[:_MAX_ERROR_LEN]
        index = min(feed.consecutive_failures, len(FAILURE_BACKOFF_SECONDS)) - 1
        delay = max(FAILURE_BACKOFF_SECONDS[index], 0)
        feed.next_poll_at = now + timedelta(seconds=delay)
        feed.lease_expires_at = None
        if feed.consecutive_failures >= FAILING_THRESHOLD:
            record_state(session, key=feed_key(feed_id), status="failing", error=error, now=now)
        session.commit()
