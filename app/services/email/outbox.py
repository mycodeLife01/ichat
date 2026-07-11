"""Durable synchronous email_outbox delivery for Celery workers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.models.email_outbox import EmailOutbox, OutboxStatus
from app.services.email.postmark import EmailMessage, EmailProvider, EmailSendError
from app.services.email.renderer import render

# Exponential backoff between send attempts (seconds): 1m, 5m, 15m, 1h, 6h.
BACKOFF_SCHEDULE_SECONDS = (60, 300, 900, 3600, 21600)
_MAX_ERROR_LEN = 1000

class OutboxProcessResult(StrEnum):
    """Outcome of one task invocation, separate from persisted row state."""

    SKIPPED = "skipped"
    SENT = "sent"
    RETRY = "retry"
    DEAD = "dead"
    LEASE_LOST = "lease_lost"


@dataclass(frozen=True)
class ClaimedOutbox:
    """Detached message data captured by a committed lease claim."""

    id: int
    recipient_email: str
    template: str
    payload: dict[str, Any]
    attempt_count: int


def claim_outbox(
    session: Session, outbox_id: int, *, task_id: str, lease_seconds: int
) -> ClaimedOutbox | None:
    """Atomically claim a due row in the caller's short transaction."""
    now = datetime.now(UTC)
    row = session.execute(
        update(EmailOutbox)
        .where(
            EmailOutbox.id == outbox_id,
            EmailOutbox.status == OutboxStatus.PENDING,
            EmailOutbox.next_attempt_at <= now,
        )
        .values(
            status=OutboxStatus.SENDING,
            locked_by=task_id,
            locked_until=now + timedelta(seconds=lease_seconds),
            updated_at=now,
        )
        .returning(
            EmailOutbox.id,
            EmailOutbox.recipient_email,
            EmailOutbox.template,
            EmailOutbox.payload,
            EmailOutbox.attempt_count,
        )
    ).one_or_none()
    if row is None:
        return None
    return ClaimedOutbox(
        id=row.id,
        recipient_email=row.recipient_email,
        template=row.template,
        payload=row.payload,
        attempt_count=row.attempt_count,
    )


def bump_attempt(session: Session, *, outbox_id: int, task_id: str) -> bool:
    """Persist one provider attempt while the caller still owns a live lease."""
    now = datetime.now(UTC)
    bumped_id = session.scalar(
        update(EmailOutbox)
        .where(
            EmailOutbox.id == outbox_id,
            EmailOutbox.status == OutboxStatus.SENDING,
            EmailOutbox.locked_by == task_id,
            EmailOutbox.locked_until >= now,
        )
        .values(
            attempt_count=EmailOutbox.attempt_count + 1,
            updated_at=now,
        )
        .returning(EmailOutbox.id)
    )
    return bumped_id is not None


def _owned_outbox(session: Session, *, outbox_id: int, task_id: str) -> EmailOutbox | None:
    now = datetime.now(UTC)
    return session.scalar(
        select(EmailOutbox)
        .where(
            EmailOutbox.id == outbox_id,
            EmailOutbox.status == OutboxStatus.SENDING,
            EmailOutbox.locked_by == task_id,
            EmailOutbox.locked_until >= now,
        )
        .with_for_update()
    )


def mark_sent(
    session: Session,
    *,
    outbox_id: int,
    task_id: str,
    provider: str,
    provider_message_id: str | None,
) -> bool:
    """Record success only if this task still owns the live lease."""
    outbox = _owned_outbox(session, outbox_id=outbox_id, task_id=task_id)
    if outbox is None:
        return False
    now = datetime.now(UTC)
    outbox.status = OutboxStatus.SENT
    outbox.provider = provider
    outbox.provider_message_id = provider_message_id
    outbox.sent_at = now
    outbox.locked_by = None
    outbox.locked_until = None
    outbox.last_error = None
    outbox.updated_at = now
    return True


def mark_failure(
    session: Session,
    *,
    outbox_id: int,
    task_id: str,
    error: str,
    max_attempts: int,
) -> OutboxProcessResult | None:
    """Schedule a retry or exhaust the budget for the current lease owner."""
    outbox = _owned_outbox(session, outbox_id=outbox_id, task_id=task_id)
    if outbox is None:
        return None
    now = datetime.now(UTC)
    outbox.last_error = error[:_MAX_ERROR_LEN]
    outbox.locked_by = None
    outbox.locked_until = None
    if outbox.attempt_count >= max_attempts:
        outbox.status = OutboxStatus.DEAD
        result = OutboxProcessResult.DEAD
    else:
        outbox.status = OutboxStatus.PENDING
        index = min(outbox.attempt_count, len(BACKOFF_SCHEDULE_SECONDS)) - 1
        outbox.next_attempt_at = now + timedelta(seconds=BACKOFF_SCHEDULE_SECONDS[index])
        result = OutboxProcessResult.RETRY
    outbox.updated_at = now
    return result


def mark_dead(
    session: Session, *, outbox_id: int, task_id: str, error: str
) -> bool:
    """Permanently fail an outbox only if this task still owns its live lease."""
    outbox = _owned_outbox(session, outbox_id=outbox_id, task_id=task_id)
    if outbox is None:
        return False
    now = datetime.now(UTC)
    outbox.status = OutboxStatus.DEAD
    outbox.last_error = error[:_MAX_ERROR_LEN]
    outbox.locked_by = None
    outbox.locked_until = None
    outbox.updated_at = now
    return True


def sweep_outbox(session: Session) -> list[int]:
    """Recover expired leases and return all due pending outbox ids."""
    now = datetime.now(UTC)
    expired = (
        session.execute(
            select(EmailOutbox)
            .where(
                EmailOutbox.status == OutboxStatus.SENDING,
                EmailOutbox.locked_until < now,
            )
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )
    for outbox in expired:
        outbox.status = OutboxStatus.PENDING
        outbox.locked_by = None
        outbox.locked_until = None
        if outbox.next_attempt_at < now:
            outbox.next_attempt_at = now
        outbox.updated_at = now
    session.flush()

    due = (
        session.execute(
            select(EmailOutbox.id).where(
                EmailOutbox.status == OutboxStatus.PENDING,
                EmailOutbox.next_attempt_at <= now,
            )
        )
        .scalars()
        .all()
    )
    return list(due)


def process_outbox(
    session_factory: sessionmaker[Session],
    *,
    outbox_id: int,
    settings: Settings,
    provider: EmailProvider,
    task_id: str,
) -> OutboxProcessResult:
    """Deliver one outbox using short durable transactions around network I/O."""
    with session_factory() as session:
        claimed = claim_outbox(
            session,
            outbox_id,
            task_id=task_id,
            lease_seconds=settings.email_outbox_lease_seconds,
        )
        session.commit()
    if claimed is None:
        return OutboxProcessResult.SKIPPED
    if claimed.attempt_count >= settings.email_outbox_max_attempts:
        with session_factory() as session:
            terminated = mark_dead(
                session,
                outbox_id=claimed.id,
                task_id=task_id,
                error="Email outbox attempt budget exhausted",
            )
            session.commit()
        return OutboxProcessResult.DEAD if terminated else OutboxProcessResult.LEASE_LOST

    rendered = render(claimed.template, claimed.payload)
    message = EmailMessage(
        to=claimed.recipient_email,
        subject=rendered.subject,
        html=rendered.html,
        text=rendered.text,
        tag=claimed.template,
        metadata={"outbox_id": str(claimed.id)},
    )

    with session_factory() as session:
        owns_attempt = bump_attempt(session, outbox_id=claimed.id, task_id=task_id)
        session.commit()
    if not owns_attempt:
        return OutboxProcessResult.LEASE_LOST

    try:
        result = provider.send(message)
    except EmailSendError as exc:
        with session_factory() as session:
            if exc.retryable:
                outcome = mark_failure(
                    session,
                    outbox_id=claimed.id,
                    task_id=task_id,
                    error=str(exc),
                    max_attempts=settings.email_outbox_max_attempts,
                )
            else:
                outcome = (
                    OutboxProcessResult.DEAD
                    if mark_dead(
                        session,
                        outbox_id=claimed.id,
                        task_id=task_id,
                        error=str(exc),
                    )
                    else None
                )
            session.commit()
        return outcome or OutboxProcessResult.LEASE_LOST

    with session_factory() as session:
        recorded = mark_sent(
            session,
            outbox_id=claimed.id,
            task_id=task_id,
            provider=result.provider,
            provider_message_id=result.provider_message_id,
        )
        session.commit()
    return OutboxProcessResult.SENT if recorded else OutboxProcessResult.LEASE_LOST
