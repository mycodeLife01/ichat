import asyncio
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Finish, Provider, TextDelta
from app.worker.main import run_worker_loop
from tests.providers.fake import FakeProvider

TEST_DATABASE_URL = os.environ.get(
    "WORKER_MAIN_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "worker-main-test.example.com"


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


async def make_queued_run(session: AsyncSession) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"main-{suffix}",
        email=f"main-{suffix}@{TEST_EMAIL_DOMAIN}",
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
        status="queued",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await session.flush()
    return run.id


async def make_lease_expired_run(session: AsyncSession) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"main-stuck-{suffix}",
        email=f"main-stuck-{suffix}@{TEST_EMAIL_DOMAIN}",
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
        status="streaming",
        provider_name="fake",
        provider_model="fake-model",
        lease_owner="dead-worker",
        lease_expires_at=datetime.now(UTC) - timedelta(seconds=5),
    )
    session.add(run)
    await session.flush()
    return run.id


async def test_run_worker_loop_processes_queued_runs_with_fake_provider(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        queued_id = await make_queued_run(session)
        await session.commit()

    settings = get_settings().model_copy(
        update={
            "worker_poll_interval_seconds": 0.05,
            "worker_heartbeat_interval_seconds": 0.05,
            "run_lease_seconds": 30,
        }
    )

    def resolve(name: str, *, settings: Settings) -> Provider:
        return FakeProvider(
            script=[
                TextDelta(text="Hi"),
                Finish(finish_reason="stop"),
            ]
        )

    stop_event = asyncio.Event()

    async def stop_after_succeed() -> None:
        for _ in range(60):
            await asyncio.sleep(0.1)
            async with session_factory() as session:
                run = await session.get(Run, queued_id)
                if run is not None and run.status == "succeeded":
                    stop_event.set()
                    return
        stop_event.set()

    watch_task = asyncio.create_task(stop_after_succeed())
    worker_task = asyncio.create_task(
        run_worker_loop(
            session_factory=session_factory,
            settings=settings,
            worker_id="worker-loop-test",
            resolve_provider=resolve,
            stop_event=stop_event,
            recovery_interval_seconds=0.2,
        )
    )

    try:
        await asyncio.wait_for(worker_task, timeout=10.0)
    finally:
        watch_task.cancel()

    async with session_factory() as session:
        run = await session.get(Run, queued_id)
        assert run is not None
        assert run.status == "succeeded"


async def test_run_worker_loop_recovers_lease_expired_runs(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        stuck_id = await make_lease_expired_run(session)
        await session.commit()

    settings = get_settings().model_copy(
        update={
            "worker_poll_interval_seconds": 0.05,
            "worker_heartbeat_interval_seconds": 0.05,
            "run_lease_seconds": 30,
        }
    )

    def resolve(name: str, *, settings: Settings) -> Provider:
        return FakeProvider(script=[Finish(finish_reason="stop")])

    stop_event = asyncio.Event()

    async def stop_after_recovery() -> None:
        for _ in range(60):
            await asyncio.sleep(0.1)
            async with session_factory() as session:
                run = await session.get(Run, stuck_id)
                if run is not None and run.status == "failed":
                    stop_event.set()
                    return
        stop_event.set()

    watch_task = asyncio.create_task(stop_after_recovery())
    worker_task = asyncio.create_task(
        run_worker_loop(
            session_factory=session_factory,
            settings=settings,
            worker_id="worker-loop-test",
            resolve_provider=resolve,
            stop_event=stop_event,
            recovery_interval_seconds=0.1,
        )
    )

    try:
        await asyncio.wait_for(worker_task, timeout=10.0)
    finally:
        watch_task.cancel()

    async with session_factory() as session:
        run = await session.get(Run, stuck_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "lease_expired"
