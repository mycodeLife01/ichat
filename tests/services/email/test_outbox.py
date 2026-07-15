"""PostgreSQL integration tests for durable email outbox delivery."""

import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.models.email_outbox import EmailOutbox, OutboxStatus
from app.services.email.outbox import (
    OutboxProcessResult,
    claim_outbox,
    mark_dead,
    mark_failure,
    mark_sent,
    process_outbox,
    sweep_outbox,
)
from app.services.email.providers import (
    EmailMessage,
    EmailSendError,
    FakeProvider,
    SendResult,
)

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
def session_factory() -> Iterator[sessionmaker[Session]]:
    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as setup:
        _clean(setup)
        setup.commit()
    yield factory
    with factory() as teardown:
        _clean(teardown)
        teardown.commit()
    engine.dispose()


def _settings() -> SimpleNamespace:
    return SimpleNamespace(email_outbox_lease_seconds=120, email_outbox_max_attempts=5)


def make_outbox(
    session: Session,
    *,
    status: OutboxStatus = OutboxStatus.PENDING,
    attempt_count: int = 0,
    next_attempt_at: datetime | None = None,
    locked_by: str | None = None,
    locked_until: datetime | None = None,
) -> int:
    outbox = EmailOutbox(
        kind="email_verification",
        recipient_email=f"out-{uuid4().hex}@{TEST_DOMAIN}",
        subject="Verify your iChat email",
        template="email_verification",
        payload={"verification_url": "https://chat.feslia.com/verify-email?token=abc"},
        status=status,
        attempt_count=attempt_count,
        next_attempt_at=next_attempt_at or datetime.now(UTC),
        locked_by=locked_by,
        locked_until=locked_until,
    )
    session.add(outbox)
    session.flush()
    return outbox.id


def load_outbox(factory: sessionmaker[Session], outbox_id: int) -> EmailOutbox:
    with factory() as session:
        outbox = session.get(EmailOutbox, outbox_id)
        assert outbox is not None
        session.expunge(outbox)
        return outbox


def expire_lease(factory: sessionmaker[Session], outbox_id: int) -> None:
    with factory() as session:
        session.execute(
            update(EmailOutbox)
            .where(EmailOutbox.id == outbox_id)
            .values(locked_until=datetime.now(UTC) - timedelta(seconds=1))
        )
        session.commit()


def test_concurrent_workers_only_one_claims_row(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup)
        setup.commit()
    barrier = Barrier(2)

    def claim(task_id: str) -> bool:
        with session_factory() as session:
            barrier.wait()
            claimed = claim_outbox(session, outbox_id, task_id=task_id, lease_seconds=120)
            session.commit()
            return claimed is not None

    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(claim, ("worker-1", "worker-2")))

    assert claims.count(True) == 1
    assert claims.count(False) == 1


def test_claim_before_send_crash_is_visible_and_does_not_consume_attempt(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup)
        setup.commit()
    with session_factory() as worker:
        claimed = claim_outbox(worker, outbox_id, task_id="crashed", lease_seconds=120)
        worker.commit()

    assert claimed is not None
    persisted = load_outbox(session_factory, outbox_id)
    assert persisted.status is OutboxStatus.SENDING
    assert persisted.locked_by == "crashed"
    assert persisted.attempt_count == 0

    expire_lease(session_factory, outbox_id)
    with session_factory() as sweeper:
        due = sweep_outbox(sweeper)
        sweeper.commit()
    with session_factory() as replacement:
        reclaimed = claim_outbox(
            replacement, outbox_id, task_id="replacement", lease_seconds=120
        )
        replacement.commit()

    assert outbox_id in due
    assert reclaimed is not None
    assert load_outbox(session_factory, outbox_id).attempt_count == 0


def test_provider_observes_durable_attempt_without_row_lock(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup)
        setup.commit()

    class ObservingProvider:
        observed_status: OutboxStatus | None = None
        observed_attempt_count: int | None = None

        def send(self, message: EmailMessage) -> SendResult:
            with session_factory() as observer:
                outbox = observer.scalar(
                    select(EmailOutbox)
                    .where(EmailOutbox.id == outbox_id)
                    .with_for_update(nowait=True)
                )
                assert outbox is not None
                self.observed_status = outbox.status
                self.observed_attempt_count = outbox.attempt_count
                observer.rollback()
            return SendResult(provider="fake", provider_message_id="message-1")

    provider = ObservingProvider()
    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=provider,
        task_id="worker-1",
    )

    assert result is OutboxProcessResult.SENT
    assert provider.observed_status is OutboxStatus.SENDING
    assert provider.observed_attempt_count == 1


def test_send_then_crash_preserves_attempt_and_is_retried_at_least_once(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup)
        setup.commit()

    class SendThenCrashProvider:
        sent: list[EmailMessage] = []

        def send(self, message: EmailMessage) -> SendResult:
            self.sent.append(message)
            raise RuntimeError("worker crashed after provider accepted the email")

    crashed_provider = SendThenCrashProvider()
    with pytest.raises(RuntimeError, match="crashed after provider"):
        process_outbox(
            session_factory,
            outbox_id=outbox_id,
            settings=_settings(),
            provider=crashed_provider,
            task_id="crashed",
        )

    persisted = load_outbox(session_factory, outbox_id)
    assert persisted.status is OutboxStatus.SENDING
    assert persisted.attempt_count == 1
    assert len(crashed_provider.sent) == 1

    expire_lease(session_factory, outbox_id)
    with session_factory() as sweeper:
        assert outbox_id in sweep_outbox(sweeper)
        sweeper.commit()
    replacement_provider = FakeProvider()
    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=replacement_provider,
        task_id="replacement",
    )

    assert result is OutboxProcessResult.SENT
    assert len(replacement_provider.sent) == 1
    final = load_outbox(session_factory, outbox_id)
    assert final.status is OutboxStatus.SENT
    assert final.attempt_count == 2


def test_send_then_crash_at_attempt_limit_does_not_dispatch_again(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup, attempt_count=4)
        setup.commit()

    class SendThenCrashProvider:
        def send(self, message: EmailMessage) -> SendResult:
            raise RuntimeError("worker crashed after fifth provider attempt")

    with pytest.raises(RuntimeError, match="fifth provider attempt"):
        process_outbox(
            session_factory,
            outbox_id=outbox_id,
            settings=_settings(),
            provider=SendThenCrashProvider(),
            task_id="crashed",
        )
    expire_lease(session_factory, outbox_id)
    with session_factory() as sweeper:
        assert outbox_id in sweep_outbox(sweeper)
        sweeper.commit()

    replacement_provider = FakeProvider()
    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=replacement_provider,
        task_id="replacement",
    )

    assert result is OutboxProcessResult.DEAD
    assert replacement_provider.sent == []
    final = load_outbox(session_factory, outbox_id)
    assert final.status is OutboxStatus.DEAD
    assert final.attempt_count == 5


def test_expired_owner_cannot_complete_retry_or_terminate_new_lease(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_ids = [make_outbox(setup) for _ in range(3)]
        setup.commit()
    for outbox_id in outbox_ids:
        with session_factory() as first_owner:
            assert claim_outbox(
                first_owner, outbox_id, task_id="expired", lease_seconds=120
            )
            first_owner.commit()
        expire_lease(session_factory, outbox_id)
    with session_factory() as sweeper:
        sweep_outbox(sweeper)
        sweeper.commit()
    for outbox_id in outbox_ids:
        with session_factory() as new_owner:
            assert claim_outbox(
                new_owner, outbox_id, task_id="current", lease_seconds=120
            )
            new_owner.commit()

    with session_factory() as stale:
        assert not mark_sent(
            stale,
            outbox_id=outbox_ids[0],
            task_id="expired",
            provider="fake",
            provider_message_id="stale",
        )
        assert (
            mark_failure(
                stale,
                outbox_id=outbox_ids[1],
                task_id="expired",
                error="stale",
                max_attempts=5,
            )
            is None
        )
        assert not mark_dead(
            stale, outbox_id=outbox_ids[2], task_id="expired", error="stale"
        )
        stale.commit()

    for outbox_id in outbox_ids:
        current = load_outbox(session_factory, outbox_id)
        assert current.status is OutboxStatus.SENDING
        assert current.locked_by == "current"


def test_sweep_recovers_expired_lease_but_not_live_lease(
    session_factory: sessionmaker[Session],
) -> None:
    now = datetime.now(UTC)
    with session_factory() as setup:
        expired_id = make_outbox(
            setup,
            status=OutboxStatus.SENDING,
            locked_by="expired",
            locked_until=now - timedelta(seconds=1),
        )
        live_id = make_outbox(
            setup,
            status=OutboxStatus.SENDING,
            locked_by="live",
            locked_until=now + timedelta(minutes=2),
        )
        setup.commit()
    with session_factory() as sweeper:
        due = sweep_outbox(sweeper)
        sweeper.commit()

    assert expired_id in due
    assert live_id not in due
    assert load_outbox(session_factory, expired_id).status is OutboxStatus.PENDING
    live = load_outbox(session_factory, live_id)
    assert live.status is OutboxStatus.SENDING
    assert live.locked_by == "live"


def test_retryable_failure_exhausts_persisted_attempt_budget(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup, attempt_count=4)
        setup.commit()
    provider = FakeProvider(fail_with=EmailSendError("temporary", retryable=True))

    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=provider,
        task_id="worker-1",
    )

    assert result is OutboxProcessResult.DEAD
    persisted = load_outbox(session_factory, outbox_id)
    assert persisted.status is OutboxStatus.DEAD
    assert persisted.attempt_count == 5


def test_retryable_failure_schedules_retry(session_factory: sessionmaker[Session]) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup)
        setup.commit()
    provider = FakeProvider(fail_with=EmailSendError("temporary", retryable=True))

    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=provider,
        task_id="worker-1",
    )

    assert result is OutboxProcessResult.RETRY
    persisted = load_outbox(session_factory, outbox_id)
    assert persisted.status is OutboxStatus.PENDING
    assert persisted.attempt_count == 1
    assert persisted.next_attempt_at > datetime.now(UTC)


def test_non_retryable_failure_marks_dead(session_factory: sessionmaker[Session]) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup)
        setup.commit()
    provider = FakeProvider(fail_with=EmailSendError("bad sender", retryable=False))

    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=provider,
        task_id="worker-1",
    )

    assert result is OutboxProcessResult.DEAD
    assert load_outbox(session_factory, outbox_id).status is OutboxStatus.DEAD


def test_process_skips_unclaimable_row(session_factory: sessionmaker[Session]) -> None:
    with session_factory() as setup:
        outbox_id = make_outbox(setup, status=OutboxStatus.SENT)
        setup.commit()
    provider = FakeProvider()

    result = process_outbox(
        session_factory,
        outbox_id=outbox_id,
        settings=_settings(),
        provider=provider,
        task_id="worker-1",
    )

    assert result is OutboxProcessResult.SKIPPED
    assert provider.sent == []
