"""Celery entry points for anime tracking (queue ``anime``).

Thin wrappers: every state transition lives in ``app.services.anime``. Each
message carries only an id; PostgreSQL rows are the source of truth and the
beat sweeps re-enqueue anything whose message was lost.
"""

from __future__ import annotations

import uuid
from functools import lru_cache

from loguru import logger

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.services.anime import (
    build_drive_adapter,
    build_notifier,
    downloads,
    feeds,
    fetch_feed_body,
    health,
    http_client,
)
from app.services.anime.notify import NotifyError, TelegramNotifier, compose_notice, download_thumb
from app.services.anime.openlist import OpenListAdapter
from app.tasks.celery_app import celery_app

_DISABLED = "disabled"


@lru_cache
def _adapter() -> OpenListAdapter:
    # Cached per worker process so the OpenList token is reused across tasks.
    return build_drive_adapter(get_settings())


@lru_cache
def _notifier() -> TelegramNotifier:
    return build_notifier(get_settings())


def _enabled() -> bool:
    return get_settings().anime_enabled


@celery_app.task(name="app.tasks.anime_tasks.dispatch_due_feeds")  # type: ignore[untyped-decorator]
def dispatch_due_feeds() -> int:
    if not _enabled():
        return 0
    with get_sync_session_factory()() as session:
        feed_ids = feeds.claim_due_feeds(session)
        session.commit()
    for feed_id in feed_ids:
        poll_feed.delay(feed_id)
    return len(feed_ids)


@celery_app.task(name="app.tasks.anime_tasks.poll_feed")  # type: ignore[untyped-decorator]
def poll_feed(feed_id: int) -> int:
    if not _enabled():
        return 0
    result = feeds.poll_feed(
        get_sync_session_factory(),
        feed_id,
        fetch=fetch_feed_body,
        storage_root=get_settings().anime_storage_root,
    )
    for public_id in result.new_downloads:
        submit_download.delay(str(public_id))
    return len(result.new_downloads)


@celery_app.task(name="app.tasks.anime_tasks.submit_download")  # type: ignore[untyped-decorator]
def submit_download(public_id: str) -> str:
    if not _enabled():
        return _DISABLED
    settings = get_settings()
    outcome = downloads.submit_download(
        get_sync_session_factory(),
        uuid.UUID(public_id),
        _adapter(),
        lease_seconds=settings.anime_submit_lease_seconds,
    )
    if outcome.result == "running":
        check_download.apply_async(args=[public_id], countdown=downloads.FIRST_CHECK_DELAY_SECONDS)
    elif outcome.result == "dead":
        notify_download.delay(public_id)
    elif outcome.result == "stale":
        _best_effort_notice(
            f"下载任务 {public_id} 提交写回时已失去所有权，请在 OpenList 核对是否多出一个离线任务"
        )
    return outcome.result


@celery_app.task(name="app.tasks.anime_tasks.check_download")  # type: ignore[untyped-decorator]
def check_download(public_id: str) -> str:
    if not _enabled():
        return _DISABLED
    outcome = downloads.check_download(
        get_sync_session_factory(),
        uuid.UUID(public_id),
        _adapter(),
        stall_timeout_seconds=get_settings().anime_download_stall_timeout_seconds,
    )
    if outcome.result == "rescheduled" and outcome.delay_seconds is not None:
        check_download.apply_async(args=[public_id], countdown=outcome.delay_seconds)
    elif outcome.result in ("completed", "failed"):
        notify_download.delay(public_id)
    return outcome.result


@celery_app.task(name="app.tasks.anime_tasks.notify_download")  # type: ignore[untyped-decorator]
def notify_download(public_id: str) -> str:
    if not _enabled():
        return _DISABLED
    return downloads.notify_download(
        get_sync_session_factory(),
        uuid.UUID(public_id),
        _adapter(),
        _notifier(),
        fetch_thumb=lambda url: download_thumb(http_client(), url),
    )


@celery_app.task(name="app.tasks.anime_tasks.poll_running_downloads")  # type: ignore[untyped-decorator]
def poll_running_downloads() -> int:
    if not _enabled():
        return 0
    with get_sync_session_factory()() as session:
        due = downloads.due_check_ids(session)
    for public_id in due:
        check_download.delay(str(public_id))
    return len(due)


@celery_app.task(name="app.tasks.anime_tasks.maintain_downloads")  # type: ignore[untyped-decorator]
def maintain_downloads() -> dict[str, int]:
    if not _enabled():
        return {}
    factory = get_sync_session_factory()
    with factory() as session:
        due = downloads.maintenance_due(session)
    for public_id in due.submit:
        submit_download.delay(str(public_id))
    for public_id in due.notify:
        notify_download.delay(str(public_id))
    alerts = health.send_due_alerts(factory, _notifier())
    result = {"submit": len(due.submit), "notify": len(due.notify), "alerts": alerts}
    if any(result.values()):
        logger.info("maintain_anime_downloads result={result}", result=result)
    return result


@celery_app.task(name="app.tasks.anime_tasks.health_check")  # type: ignore[untyped-decorator]
def health_check() -> str:
    if not _enabled():
        return _DISABLED
    factory = get_sync_session_factory()
    status = health.run_health_check(factory, _adapter())
    health.send_due_alerts(factory, _notifier())
    return "ok" if status.ok else "down"


def _best_effort_notice(text: str) -> None:
    # Diagnostic only (at-most-once); the error log is the durable record.
    try:
        _notifier().send(compose_notice(text))
    except NotifyError as exc:
        logger.warning("anime notice not sent: {error}", error=str(exc))
