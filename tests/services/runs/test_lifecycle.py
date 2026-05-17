import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    is_cancelling,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    renew_lease,
    run_has_text_delta,
)

TEST_DATABASE_URL = os.environ.get(
    "RUN_LIFECYCLE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "run-lifecycle-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def make_run(session: AsyncSession, *, status_value: str = "queued") -> Run:
    suffix = uuid4().hex
    user = User(
        username=f"life-{suffix}",
        email=f"life-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status=status_value,
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    return run


async def test_claim_next_queued_run_moves_run_to_started_and_writes_run_started_event(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        await session.commit()
        run_id = run.id

    async with session_factory() as session:
        claimed_id = await claim_next_queued_run(
            session,
            worker_id="worker-a",
            lease_seconds=60,
        )
        await session.commit()

    assert claimed_id == run_id

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "started"
        assert updated.lease_owner == "worker-a"
        assert updated.lease_expires_at is not None
        assert updated.started_at is not None
        assert updated.heartbeat_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == ["run_started"]


async def test_claim_next_queued_run_returns_none_when_nothing_queued(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        claimed_id = await claim_next_queued_run(
            session,
            worker_id="worker-a",
            lease_seconds=60,
        )
        await session.commit()

    assert claimed_id is None


async def test_concurrent_claims_only_one_winner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        await session.commit()
        run_id = run.id

    async with session_factory() as session_a, session_factory() as session_b:
        claimed_a = await claim_next_queued_run(
            session_a,
            worker_id="worker-a",
            lease_seconds=60,
        )
        claimed_b = await claim_next_queued_run(
            session_b,
            worker_id="worker-b",
            lease_seconds=60,
        )
        await session_a.commit()
        await session_b.commit()

    assert {claimed_a, claimed_b} == {run_id, None}


async def test_mark_run_streaming_sets_status_and_first_streamed_at(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="started")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        await mark_run_streaming(session, run_id=run_id)
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "streaming"
        assert updated.first_streamed_at is not None


async def test_mark_run_succeeded_writes_terminal_event_and_clears_lease(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run.lease_owner = "worker-a"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        await mark_run_succeeded(
            session,
            run_id=run_id,
            usage={"prompt_tokens": 5},
            provider_request_id="req-1",
        )
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "succeeded"
        assert updated.lease_owner is None
        assert updated.lease_expires_at is None
        assert updated.completed_at is not None
        assert updated.usage_metadata == {"prompt_tokens": 5}
        assert updated.provider_request_id == "req-1"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_succeeded"
        assert events[-1].payload == {"usage": {"prompt_tokens": 5}}


async def test_mark_run_failed_writes_terminal_event_and_records_error(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run.lease_owner = "worker-a"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        await mark_run_failed(
            session,
            run_id=run_id,
            code="upstream_5xx",
            message="bad upstream",
        )
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "failed"
        assert updated.error_code == "upstream_5xx"
        assert updated.error_message == "bad upstream"
        assert updated.failed_at is not None
        assert updated.lease_owner is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_failed"
        assert events[-1].payload == {"code": "upstream_5xx", "message": "bad upstream"}


async def test_renew_lease_extends_expiry_and_heartbeat(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run.lease_owner = "worker-a"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=5)
        run.heartbeat_at = datetime.now(UTC)
        run_id = run.id
        original_expiry = run.lease_expires_at
        await session.commit()

    async with session_factory() as session:
        await renew_lease(session, run_id=run_id, lease_seconds=120)
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.lease_expires_at is not None
        assert updated.lease_expires_at > original_expiry


async def test_is_cancelling_reflects_status(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        assert await is_cancelling(session, run_id=run_id) is False
        updated = await session.get(Run, run_id)
        assert updated is not None
        updated.status = "cancelling"
        await session.commit()

    async with session_factory() as session:
        assert await is_cancelling(session, run_id=run_id) is True


async def test_run_has_text_delta_detects_persisted_deltas(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    from app.services.runs.service import append_run_event

    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        assert await run_has_text_delta(session, run_id=run_id) is False
        await append_run_event(
            session,
            run_id=run_id,
            event_type="text_delta",
            payload={"text": "hi"},
        )
        await session.commit()
        assert await run_has_text_delta(session, run_id=run_id) is True
