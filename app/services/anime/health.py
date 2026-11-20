"""Integration health and alert delivery (spec §7.7).

``status`` changes are recorded in the same transaction that observes them;
whether the alert went out is tracked separately in ``alerted_status`` and
retried until it does, so a correlated outage cannot swallow the alert.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from loguru import logger
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, sessionmaker

from app.models.anime import AnimeIntegrationState
from app.services.anime.drive import CloudDriveAdapter, DriveHealth
from app.services.anime.notify import Notifier, NotifyError, compose_alert

DRIVE_KEY = "drive"
ALERT_BACKOFF_SECONDS = (60, 300, 900, 3600, 21600)
ALERT_LONG_RETRY_SECONDS = 21600
ALERT_CLAIM_SECONDS = 120


def feed_key(feed_id: int) -> str:
    return f"feed:{feed_id}"


def record_state(
    session: Session, *, key: str, status: str, error: str | None, now: datetime
) -> bool:
    """Record the observed status; return True when it changed."""
    if status == "ok":
        row = session.scalar(
            select(AnimeIntegrationState).where(AnimeIntegrationState.key == key).with_for_update()
        )
        if row is None:
            # Never-failed objects need no row: nothing to announce.
            return False
    else:
        session.execute(
            insert(AnimeIntegrationState)
            .values(
                key=key,
                status=status,
                since=now,
                last_error=error,
                alerted_status="ok",
                next_alert_at=now,
            )
            .on_conflict_do_nothing(index_elements=["key"])
        )
        row = session.scalar(
            select(AnimeIntegrationState).where(AnimeIntegrationState.key == key).with_for_update()
        )
        assert row is not None
    changed = row.status != status
    if changed:
        row.status = status
        row.since = now
        row.alert_attempts = 0
        row.next_alert_at = now
        logger.bind(event="anime_health_changed", key=key, status=status).info(
            "anime integration status changed"
        )
    row.last_error = error
    row.updated_at = now
    return changed


@dataclass(frozen=True)
class _DueAlert:
    id: int
    key: str
    status: str
    last_error: str | None
    alert_attempts: int


def send_due_alerts(
    factory: sessionmaker[Session], notifier: Notifier, *, now: datetime | None = None
) -> int:
    moment = now or datetime.now(UTC)
    with factory() as session:
        rows = session.execute(
            update(AnimeIntegrationState)
            .where(
                AnimeIntegrationState.status != AnimeIntegrationState.alerted_status,
                AnimeIntegrationState.next_alert_at <= moment,
            )
            # Short claim so health_check and maintain do not both send.
            .values(next_alert_at=moment + timedelta(seconds=ALERT_CLAIM_SECONDS))
            .returning(
                AnimeIntegrationState.id,
                AnimeIntegrationState.key,
                AnimeIntegrationState.status,
                AnimeIntegrationState.last_error,
                AnimeIntegrationState.alert_attempts,
            )
        ).all()
        session.commit()
    due = [_DueAlert(r.id, r.key, r.status, r.last_error, r.alert_attempts) for r in rows]

    sent = 0
    for alert in due:
        try:
            notifier.send(compose_alert(alert.key, alert.status, alert.last_error))
            ok = True
        except NotifyError as exc:
            ok = False
            logger.bind(event="anime_alert_failed", key=alert.key).warning(str(exc))
        with factory() as session:
            row = session.get(AnimeIntegrationState, alert.id, with_for_update=True)
            if row is not None:
                _finish_alert(row, alert, ok=ok, now=datetime.now(UTC))
            session.commit()
        if ok:
            sent += 1
            logger.bind(event="anime_alert_sent", key=alert.key, status=alert.status).info(
                "anime alert sent"
            )
    return sent


def _finish_alert(row: AnimeIntegrationState, alert: _DueAlert, *, ok: bool, now: datetime) -> None:
    if ok:
        row.alerted_status = alert.status
        row.alert_attempts = 0
        # A change during the send leaves status != alerted_status: send again.
        row.next_alert_at = now if row.status != alert.status else None
        return
    attempts = alert.alert_attempts + 1
    row.alert_attempts = attempts
    if row.status != alert.status:
        row.next_alert_at = now
        return
    # Alerts are the only failure signal: no dead state, slow retry forever.
    delay = (
        ALERT_BACKOFF_SECONDS[attempts - 1]
        if attempts <= len(ALERT_BACKOFF_SECONDS)
        else ALERT_LONG_RETRY_SECONDS
    )
    row.next_alert_at = now + timedelta(seconds=delay)


def run_health_check(
    factory: sessionmaker[Session], adapter: CloudDriveAdapter, *, now: datetime | None = None
) -> DriveHealth:
    health = adapter.health()
    with factory() as session:
        record_state(
            session,
            key=DRIVE_KEY,
            status="ok" if health.ok else "down",
            error=health.error,
            now=now or datetime.now(UTC),
        )
        session.commit()
    return health
