"""Operator CLI for anime tracking: ``python -m app.anime_admin``.

Feed URLs are credentials (Mikan personal RSS tokens); this CLI only prints
them redacted.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.models.anime import DOWNLOAD_STATUSES, AnimeDownload, AnimeFeed, AnimeRelease
from app.services.anime import build_drive_adapter, fetch_feed_body
from app.services.anime.downloads import (
    DownloadActionError,
    add_manual_download,
    retry_download,
)
from app.services.anime.drive import join_path
from app.services.anime.feeds import poll_feed
from app.services.anime.filters import DEFAULT_FILTERS, InvalidFilters, validate_filters
from app.services.anime.health import run_health_check
from app.services.anime.infohash import InvalidInfohash
from app.services.anime.parsing import parse_title
from app.services.anime.sources import redact_url


class CliError(Exception):
    pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.anime_admin")
    groups = parser.add_subparsers(dest="group", required=True)

    feeds = groups.add_parser("feeds", help="Manage RSS feeds").add_subparsers(
        dest="command", required=True
    )
    add = feeds.add_parser("add", help="Add a feed")
    add.add_argument("--name", required=True)
    add.add_argument("--url", required=True)
    add.add_argument("--source", choices=("mikan",), default="mikan")
    add.add_argument("--target-dir", default="/")
    add.add_argument("--interval", type=int, default=600)
    _filter_flags(add)
    feeds.add_parser("list", help="List feeds")
    update = feeds.add_parser("update", help="Update a feed")
    update.add_argument("name")
    update.add_argument("--url")
    update.add_argument("--target-dir")
    update.add_argument("--interval", type=int)
    _filter_flags(update)
    for name in ("enable", "disable", "poll-now"):
        feeds.add_parser(name).add_argument("name")

    downloads = groups.add_parser("downloads", help="Inspect and retry downloads").add_subparsers(
        dest="command", required=True
    )
    listing = downloads.add_parser("list")
    listing.add_argument("--status", choices=DOWNLOAD_STATUSES)
    listing.add_argument("--limit", type=int, default=30)
    downloads.add_parser("retry").add_argument("public_id")
    manual = downloads.add_parser("add", help="Queue a magnet manually")
    manual.add_argument("--magnet", required=True)
    manual.add_argument("--target-dir", default="/Manual")

    releases = groups.add_parser("releases").add_subparsers(dest="command", required=True)
    releases.add_parser("parse", help="Debug the title parser").add_argument("title")

    groups.add_parser("health", help="Run a drive health check now")
    return parser


def _filter_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--include", action="append", help="Regex; repeat for AND")
    parser.add_argument("--exclude", action="append", help="Regex; repeat for OR")
    parser.add_argument("--skip-batch", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--episode-dedupe", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--backfill-hours", type=int)


def _filters_from(args: argparse.Namespace, base: dict[str, Any]) -> dict[str, Any]:
    doc = dict(base)
    if args.include is not None:
        doc["include"] = args.include
    if args.exclude is not None:
        doc["exclude"] = args.exclude
    for key in ("skip_batch", "episode_dedupe", "backfill_hours"):
        value = getattr(args, key)
        if value is not None:
            doc[key] = value
    try:
        return validate_filters(doc)
    except InvalidFilters as exc:
        raise CliError(str(exc)) from None


def _feed(session: Session, name: str) -> AnimeFeed:
    feed = session.scalar(select(AnimeFeed).where(AnimeFeed.name == name).with_for_update())
    if feed is None:
        raise CliError(f"feed not found: {name}")
    return feed


def _print(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _feed_view(feed: AnimeFeed) -> dict[str, Any]:
    return {
        "name": feed.name,
        "source": feed.source,
        "url": redact_url(feed.url),
        "target_dir": feed.target_dir,
        "filters": feed.filters,
        "enabled": feed.enabled,
        "poll_interval_seconds": feed.poll_interval_seconds,
        "next_poll_at": feed.next_poll_at,
        "last_polled_at": feed.last_polled_at,
        "consecutive_failures": feed.consecutive_failures,
        "last_error": feed.last_error,
    }


def run(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.group == "releases":
        _print(parse_title(args.title))
        return 0
    settings = get_settings()
    factory = get_sync_session_factory()
    if args.group == "health":
        health = run_health_check(factory, build_drive_adapter(settings))
        _print({"ok": health.ok, "error": health.error})
        return 0 if health.ok else 1

    with factory() as session:
        if args.group == "feeds":
            result = _feeds_command(session, args)
        else:
            result = _downloads_command(session, args, storage_root=settings.anime_storage_root)
        session.commit()
    if args.group == "feeds" and args.command == "poll-now":
        polled = poll_feed(
            factory,
            result["id"],
            fetch=fetch_feed_body,
            storage_root=settings.anime_storage_root,
        )
        _enqueue_submits([str(item) for item in polled.new_downloads])
        result = {
            "fetched": polled.fetched,
            "items": polled.items,
            "new_releases": polled.new_releases,
            "new_downloads": [str(item) for item in polled.new_downloads],
            "error": polled.error,
        }
    if args.group == "downloads" and args.command in ("retry", "add") and result.get("queued"):
        _enqueue_submits([result["public_id"]])
    _print(result)
    return 0


def _feeds_command(session: Session, args: argparse.Namespace) -> Any:
    if args.command == "add":
        feed = AnimeFeed(
            name=args.name,
            source=args.source,
            url=args.url,
            target_dir=args.target_dir,
            filters=_filters_from(args, DEFAULT_FILTERS),
            poll_interval_seconds=args.interval,
            next_poll_at=datetime.now(UTC),
        )
        session.add(feed)
        session.flush()
        session.refresh(feed)
        return _feed_view(feed)
    if args.command == "list":
        feeds = session.scalars(select(AnimeFeed).order_by(AnimeFeed.id))
        return [_feed_view(feed) for feed in feeds]
    feed = _feed(session, args.name)
    if args.command == "update":
        if args.url is not None:
            feed.url = args.url
        if args.target_dir is not None:
            feed.target_dir = args.target_dir
        if args.interval is not None:
            feed.poll_interval_seconds = args.interval
        feed.filters = _filters_from(args, feed.filters)
    elif args.command in ("enable", "disable"):
        feed.enabled = args.command == "enable"
        if feed.enabled:
            feed.next_poll_at = datetime.now(UTC)
    elif args.command == "poll-now":
        return {"id": feed.id}
    session.flush()
    return _feed_view(feed)


def _downloads_command(session: Session, args: argparse.Namespace, *, storage_root: str) -> Any:
    if args.command == "list":
        query = (
            select(AnimeDownload, AnimeRelease.title)
            .join(AnimeRelease, AnimeRelease.infohash == AnimeDownload.infohash)
            .order_by(AnimeDownload.id.desc())
            .limit(args.limit)
        )
        if args.status:
            query = query.where(AnimeDownload.status == args.status)
        return [
            {
                "public_id": row.public_id,
                "status": row.status,
                "skip_reason": row.skip_reason,
                "title": title,
                "target_dir": row.target_dir,
                "attempts": row.attempt_count,
                "last_error": row.last_error,
                "notify_status": row.notify_status,
                "file_paths": row.file_paths,
                "created_at": row.created_at,
            }
            for row, title in session.execute(query)
        ]
    if args.command == "retry":
        try:
            row = retry_download(session, uuid.UUID(args.public_id))
        except (DownloadActionError, ValueError) as exc:
            raise CliError(str(exc)) from None
        return {"public_id": str(row.public_id), "status": row.status, "queued": True}
    try:
        public_id, created = add_manual_download(
            session, magnet=args.magnet, target_dir=join_path(storage_root, args.target_dir)
        )
    except InvalidInfohash as exc:
        raise CliError(str(exc)) from None
    return {"public_id": str(public_id), "created": created, "queued": created}


def _enqueue_submits(public_ids: list[str]) -> None:
    # Best effort: maintain_downloads re-enqueues due rows if the broker is down.
    if not public_ids:
        return
    try:
        from app.tasks.anime_tasks import submit_download

        for public_id in public_ids:
            submit_download.delay(public_id)
    except Exception as exc:  # noqa: BLE001 - broker outages must not fail the CLI
        print(
            f"warning: enqueue failed ({type(exc).__name__}); the sweep will pick it up",
            file=sys.stderr,
        )


def main() -> None:
    try:
        raise SystemExit(run())
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
