"""DB-backed tests for the email outbox claim/lease/retry state machine.

Uses a synchronous psycopg session against the dev database (same convention as
tests/services/runs/test_lifecycle.py). Requires PostgreSQL to be running.
"""

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session, sessionmaker

from app.models.email_outbox import EmailOutbox
from app.services.email.outbox import (
    claim_outbox,
    process_outbox,
    sweep_outbox,
)
from app.services.email.postmark import EmailSendError, FakeProvider

TEST_DATABASE_URL = os.environ.get(
    "EMAIL_OUTBOX_TEST_DATABASE_URL",
    "postgresql+psycopg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "email-outbox-test.example.com"


def _clean(session: Session) -> None:
    session.execute(
        delete(EmailOutbox).where(EmailOutbox.recipient_email.like(f"%@{TEST_DOMAIN}"))
    )


@pytest.fixture()
def session() -> Iterator[Session]:
    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as setup:
        _clean(setup)
        setup.commit()
    with factory() as active:
        yield active
    with factory() as teardown:
        _clean(teardown)
        teardown.commit()
    engine.dispose()


def _settings() -> SimpleNamespace:
    return SimpleNamespace(email_outbox_lease_seconds=120, email_outbox_max_attempts=5)


def make_outbox(
    session: Session,
    *,
    status: str = "pending",
    attempt_count: int = 0,
    next_attempt_at: datetime | None = None,
    locked_until: datetime | None = None,
) -> EmailOutbox:
    outbox = EmailOutbox(
        kind="email_verification",
        recipient_email=f"out-{uuid4().hex}@{TEST_DOMAIN}",
        subject="Verify your iChat email",
        template="email_verification",
        payload={"verification_url": "https://chat.feslia.com/verify-email?token=abc"},
        status=status,
        attempt_count=attempt_count,
        next_attempt_at=next_attempt_at or datetime.now(UTC),
        locked_until=locked_until,
    )
    session.add(outbox)
    session.flush()
    return outbox


def test_claim_is_exclusive(session: Session) -> None:
    outbox = make_outbox(session)

    claimed = claim_outbox(session, outbox.id, task_id="t1", lease_seconds=120)
    assert claimed is not None and claimed.status == "sending"

    # Already claimed (sending) -> not claimable again.
    assert claim_outbox(session, outbox.id, task_id="t2", lease_seconds=120) is None


def test_claim_does_not_increment_attempt_count(session: Session) -> None:
    outbox = make_outbox(session)
    claim_outbox(session, outbox.id, task_id="t1", lease_seconds=120)
    assert outbox.attempt_count == 0


def test_claim_skips_rows_not_yet_due(session: Session) -> None:
    outbox = make_outbox(session, next_attempt_at=datetime.now(UTC) + timedelta(hours=1))
    assert claim_outbox(session, outbox.id, task_id="t1", lease_seconds=120) is None


def test_sweep_recovers_expired_lease(session: Session) -> None:
    outbox = make_outbox(
        session,
        status="sending",
        locked_until=datetime.now(UTC) - timedelta(minutes=1),
    )

    due = sweep_outbox(session)

    assert outbox.id in due
    assert outbox.status == "pending"
    assert outbox.locked_until is None


def test_process_outbox_sends_and_marks_sent(session: Session) -> None:
    outbox = make_outbox(session)
    provider = FakeProvider()

    result = process_outbox(
        session, outbox_id=outbox.id, settings=_settings(), provider=provider, task_id="t1"
    )

    assert result == "sent"
    assert outbox.status == "sent"
    assert outbox.attempt_count == 1
    assert outbox.provider_message_id is not None
    assert len(provider.sent) == 1


def test_process_outbox_retryable_failure_schedules_retry(session: Session) -> None:
    outbox = make_outbox(session)
    provider = FakeProvider(fail_with=EmailSendError("temporary", retryable=True))

    result = process_outbox(
        session, outbox_id=outbox.id, settings=_settings(), provider=provider, task_id="t1"
    )

    assert result == "retry"
    assert outbox.status == "pending"
    assert outbox.attempt_count == 1
    assert outbox.next_attempt_at > datetime.now(UTC)
    assert outbox.last_error is not None


def test_process_outbox_dead_after_budget_exhausted(session: Session) -> None:
    # attempt_count 4 -> bump to 5 == max_attempts -> dead.
    outbox = make_outbox(session, attempt_count=4)
    provider = FakeProvider(fail_with=EmailSendError("temporary", retryable=True))

    result = process_outbox(
        session, outbox_id=outbox.id, settings=_settings(), provider=provider, task_id="t1"
    )

    assert result == "dead"
    assert outbox.status == "dead"
    assert outbox.attempt_count == 5


def test_process_outbox_non_retryable_marks_dead(session: Session) -> None:
    outbox = make_outbox(session)
    provider = FakeProvider(fail_with=EmailSendError("bad sender", retryable=False))

    result = process_outbox(
        session, outbox_id=outbox.id, settings=_settings(), provider=provider, task_id="t1"
    )

    assert result == "dead"
    assert outbox.status == "dead"


def test_process_outbox_skips_unclaimable(session: Session) -> None:
    outbox = make_outbox(session, status="sent")
    provider = FakeProvider()

    result = process_outbox(
        session, outbox_id=outbox.id, settings=_settings(), provider=provider, task_id="t1"
    )

    assert result == "skipped"
    assert len(provider.sent) == 0
