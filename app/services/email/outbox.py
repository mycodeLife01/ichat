"""Synchronous email_outbox operations for the Celery worker.

Mirrors the LLM run claim/lease pattern in app/services/runs/lifecycle.py:
a row is claimed with ``SELECT ... FOR UPDATE`` under a ``locked_until`` lease,
and recovered by the periodic sweep if a worker dies mid-send. Idempotent and
safe under concurrent workers — only one claim succeeds per row.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.email_outbox import EmailOutbox
from app.services.email.postmark import EmailMessage, EmailProvider, EmailSendError
from app.services.email.renderer import render

# Exponential backoff between send attempts (seconds): 1m, 5m, 15m, 1h, 6h.
BACKOFF_SCHEDULE_SECONDS = (60, 300, 900, 3600, 21600)
_MAX_ERROR_LEN = 1000

STATUS_PENDING = "pending"
STATUS_SENDING = "sending"
STATUS_SENT = "sent"
STATUS_DEAD = "dead"


def claim_outbox(
    session: Session, outbox_id: int, *, task_id: str, lease_seconds: int
) -> EmailOutbox | None:
    """Claim a pending, due row under a lease. Returns None if not claimable."""
    now = datetime.now(UTC)
    outbox = session.execute(
        select(EmailOutbox).where(EmailOutbox.id == outbox_id).with_for_update()
    ).scalar_one_or_none()
    if outbox is None or outbox.status != STATUS_PENDING or outbox.next_attempt_at > now:
        return None
    outbox.status = STATUS_SENDING
    outbox.locked_by = task_id
    outbox.locked_until = now + timedelta(seconds=lease_seconds)
    outbox.updated_at = now
    session.flush()
    return outbox


def bump_attempt(session: Session, outbox: EmailOutbox) -> None:
    """Increment attempt_count immediately before invoking the provider.

    attempt_count counts real Postmark dispatch attempts, so a claim-then-crash
    (before any send) is re-claimed without consuming the retry budget.
    """
    outbox.attempt_count += 1
    outbox.updated_at = datetime.now(UTC)
    session.flush()


def mark_sent(
    session: Session, outbox: EmailOutbox, *, provider: str, provider_message_id: str | None
) -> None:
    now = datetime.now(UTC)
    outbox.status = STATUS_SENT
    outbox.provider = provider
    outbox.provider_message_id = provider_message_id
    outbox.sent_at = now
    outbox.locked_by = None
    outbox.locked_until = None
    outbox.last_error = None
    outbox.updated_at = now
    session.flush()


def mark_failure(
    session: Session, outbox: EmailOutbox, *, error: str, max_attempts: int
) -> None:
    """Schedule a retry, or mark dead once the attempt budget is exhausted."""
    now = datetime.now(UTC)
    outbox.last_error = error[:_MAX_ERROR_LEN]
    outbox.locked_by = None
    outbox.locked_until = None
    if outbox.attempt_count >= max_attempts:
        outbox.status = STATUS_DEAD
    else:
        outbox.status = STATUS_PENDING
        index = min(outbox.attempt_count, len(BACKOFF_SCHEDULE_SECONDS)) - 1
        outbox.next_attempt_at = now + timedelta(seconds=BACKOFF_SCHEDULE_SECONDS[index])
    outbox.updated_at = now
    session.flush()


def mark_dead(session: Session, outbox: EmailOutbox, *, error: str) -> None:
    now = datetime.now(UTC)
    outbox.status = STATUS_DEAD
    outbox.last_error = error[:_MAX_ERROR_LEN]
    outbox.locked_by = None
    outbox.locked_until = None
    outbox.updated_at = now
    session.flush()


def sweep_outbox(session: Session) -> list[int]:
    """Recover expired leases and return the ids of all due pending rows.

    Run periodically (celery-beat schedules it; any worker executes it). Resets
    rows stuck in ``sending`` past their lease back to ``pending`` so a worker
    that crashed before/while sending does not deadlock the row.
    """
    now = datetime.now(UTC)
    expired = (
        session.execute(
            select(EmailOutbox)
            .where(EmailOutbox.status == STATUS_SENDING, EmailOutbox.locked_until < now)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )
    for outbox in expired:
        outbox.status = STATUS_PENDING
        outbox.locked_by = None
        outbox.locked_until = None
        if outbox.next_attempt_at < now:
            outbox.next_attempt_at = now
        outbox.updated_at = now
    session.flush()

    due = (
        session.execute(
            select(EmailOutbox.id).where(
                EmailOutbox.status == STATUS_PENDING,
                EmailOutbox.next_attempt_at <= now,
            )
        )
        .scalars()
        .all()
    )
    return list(due)


def process_outbox(
    session: Session,
    *,
    outbox_id: int,
    settings: Settings,
    provider: EmailProvider,
    task_id: str,
) -> str:
    """Claim, render, send, and record the outcome for one outbox row.

    Returns one of: ``skipped`` (not claimable), ``sent``, ``retry``, ``dead``.
    The caller is responsible for committing the session.
    """
    outbox = claim_outbox(
        session, outbox_id, task_id=task_id, lease_seconds=settings.email_outbox_lease_seconds
    )
    if outbox is None:
        return "skipped"

    rendered = render(outbox.template, outbox.payload)
    message = EmailMessage(
        to=outbox.recipient_email,
        subject=rendered.subject,
        html=rendered.html,
        text=rendered.text,
        tag=outbox.template,
        metadata={"outbox_id": str(outbox.id)},
    )

    bump_attempt(session, outbox)
    try:
        result = provider.send(message)
    except EmailSendError as exc:
        if exc.retryable:
            mark_failure(
                session,
                outbox,
                error=str(exc),
                max_attempts=settings.email_outbox_max_attempts,
            )
            return STATUS_DEAD if outbox.status == STATUS_DEAD else "retry"
        mark_dead(session, outbox, error=str(exc))
        return STATUS_DEAD

    mark_sent(
        session,
        outbox,
        provider=result.provider,
        provider_message_id=result.provider_message_id,
    )
    return STATUS_SENT
