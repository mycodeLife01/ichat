import asyncio
import os
from collections.abc import AsyncIterator
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Finish, Provider, ProviderChunk, ProviderError, ProviderMessage, TextDelta
from app.services.runs.lifecycle import claim_next_queued_run
from app.worker.executor import ProviderResolver, execute_run
from tests.providers.fake import FakeProvider, RaiseError, Sleep

TEST_DATABASE_URL = os.environ.get(
    "WORKER_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "worker-test.example.com"


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


@pytest.fixture()
def settings() -> Settings:
    return get_settings()


async def queue_run(session: AsyncSession, provider_name: str = "fake") -> int:
    suffix = uuid4().hex
    user = User(
        username=f"exec-{suffix}",
        email=f"exec-{suffix}@{TEST_EMAIL_DOMAIN}",
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
        provider_name=provider_name,
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await session.flush()
    return run.id



def make_resolver(provider: Provider) -> ProviderResolver:
    def resolve(name: str, *, settings: Settings) -> Provider:
        return provider

    return resolve


async def test_execute_run_streams_deltas_marks_succeeded_and_materializes_message(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        claimed = await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()
        assert claimed == run_id

    fake = FakeProvider(
        script=[
            TextDelta(text="Hello"),
            TextDelta(text=" world"),
            Finish(
                finish_reason="stop",
                usage={"prompt_tokens": 4, "completion_tokens": 2},
                provider_request_id="req-1",
            ),
        ]
    )

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "succeeded"
        assert run.lease_owner is None
        assert run.completed_at is not None
        assert run.usage_metadata == {"prompt_tokens": 4, "completion_tokens": 2}
        assert run.provider_request_id == "req-1"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == [
            "run_started",
            "text_delta",
            "run_succeeded",
        ]
        assert events[1].payload == {"text": "Hello world"}

        messages = (
            await session.scalars(
                select(Message)
                .where(Message.conversation_id == run.conversation_id)
                .order_by(Message.position.asc())
            )
        ).all()
        assert [m.role for m in messages] == ["user", "assistant"]
        assert messages[1].content == "Hello world"
        assert messages[1].run_id == run_id


async def test_execute_run_retries_once_when_provider_fails_before_any_delta(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    call_count = {"n": 0}

    class FlakyProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise ProviderError(code="transient", message="first attempt")
            yield TextDelta(text="Recovered")
            yield Finish(finish_reason="stop")

    provider = FlakyProvider()

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    assert call_count["n"] == 2

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "succeeded"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == [
            "run_started",
            "text_delta",
            "run_succeeded",
        ]


async def test_execute_run_does_not_retry_after_persisted_delta(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    fake = FakeProvider(
        script=[
            TextDelta(text="partial"),
            RaiseError(code="upstream_5xx", message="boom mid-stream"),
        ]
    )

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "upstream_5xx"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == [
            "run_started",
            "text_delta",
            "run_failed",
        ]
        assert events[1].payload == {"text": "partial"}

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        roles = [m.role for m in messages]
        assert "assistant" not in roles


async def test_execute_run_does_not_retry_after_two_pre_delta_failures(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    call_count = {"n": 0}

    class AlwaysFailProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            call_count["n"] += 1
            raise ProviderError(code="dead", message=f"attempt {call_count['n']}")
            yield  # pragma: no cover

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(AlwaysFailProvider()),
    )

    assert call_count["n"] == 2

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "dead"


async def test_execute_run_marks_cancelled_when_context_build_fails_after_db_cancelling(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    async def fail_after_cancellation(*args: object, **kwargs: object) -> list[ProviderMessage]:
        async with session_factory() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            run.status = "cancelling"
            await session.commit()
        raise RuntimeError("context exploded after cancel")

    monkeypatch.setattr("app.worker.executor.build_context", fail_after_cancellation)

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(FakeProvider(script=[])),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None
        assert run.error_code is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == [
            "run_started",
            "run_cancelled",
        ]


async def test_execute_run_marks_cancelled_when_status_flips_during_stream(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    fake = FakeProvider(
        script=[
            TextDelta(text="part one"),
            Sleep(seconds=0.5),
            TextDelta(text="part two"),
            Sleep(seconds=0.5),
            Finish(finish_reason="stop"),
        ]
    )

    cancel_settings = settings.model_copy(update={"worker_heartbeat_interval_seconds": 0.05})

    async def flip_to_cancelling() -> None:
        await asyncio.sleep(0.2)
        async with session_factory() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            run.status = "cancelling"
            await session.commit()

    flip_task = asyncio.create_task(flip_to_cancelling())
    try:
        await execute_run(
            session_factory=session_factory,
            run_id=run_id,
            worker_id="worker-x",
            settings=cancel_settings,
            resolve_provider=make_resolver(fake),
        )
    finally:
        await flip_task

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_cancelled"

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        roles = [m.role for m in messages]
        assert "assistant" not in roles


async def test_execute_run_cancels_blocked_provider_stream_promptly(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    class BlockingProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            yield TextDelta(text="partial")
            await asyncio.Event().wait()
            yield Finish(finish_reason="stop")  # pragma: no cover

    async def flip_to_cancelling_after_delta() -> None:
        for _ in range(50):
            await asyncio.sleep(0.02)
            async with session_factory() as session:
                event = await session.scalar(
                    select(RunEvent.id).where(
                        RunEvent.run_id == run_id,
                        RunEvent.type == "text_delta",
                    )
                )
                if event is None:
                    continue
                run = await session.get(Run, run_id)
                assert run is not None
                run.status = "cancelling"
                await session.commit()
                return
        raise AssertionError("text_delta was not persisted before timeout")

    cancel_settings = settings.model_copy(update={"worker_heartbeat_interval_seconds": 0.05})
    flip_task = asyncio.create_task(flip_to_cancelling_after_delta())
    try:
        await asyncio.wait_for(
            execute_run(
                session_factory=session_factory,
                run_id=run_id,
                worker_id="worker-x",
                settings=cancel_settings,
                resolve_provider=make_resolver(BlockingProvider()),
            ),
            timeout=2.0,
        )
    finally:
        await flip_task

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == [
            "run_started",
            "text_delta",
            "run_cancelled",
        ]

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        assert [message.role for message in messages] == ["user"]


async def test_execute_run_marks_cancelled_when_provider_fails_after_db_cancelling(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    release_error = asyncio.Event()

    class ErrorAfterCancellationProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            yield TextDelta(text="partial")
            await release_error.wait()
            raise ProviderError(code="upstream_5xx", message="boom after cancel")

    async def flip_to_cancelling_after_delta() -> None:
        for _ in range(50):
            await asyncio.sleep(0.02)
            async with session_factory() as session:
                event = await session.scalar(
                    select(RunEvent.id).where(
                        RunEvent.run_id == run_id,
                        RunEvent.type == "text_delta",
                    )
                )
                if event is None:
                    continue
                run = await session.get(Run, run_id)
                assert run is not None
                run.status = "cancelling"
                await session.commit()
                release_error.set()
                return
        raise AssertionError("text_delta was not persisted before timeout")

    slow_heartbeat_settings = settings.model_copy(
        update={"worker_heartbeat_interval_seconds": 60.0}
    )
    flip_task = asyncio.create_task(flip_to_cancelling_after_delta())
    try:
        await execute_run(
            session_factory=session_factory,
            run_id=run_id,
            worker_id="worker-x",
            settings=slow_heartbeat_settings,
            resolve_provider=make_resolver(ErrorAfterCancellationProvider()),
        )
    finally:
        await flip_task

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None
        assert run.error_code is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == [
            "run_started",
            "text_delta",
            "run_cancelled",
        ]

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        assert [message.role for message in messages] == ["user"]


async def test_execute_run_renews_lease_during_long_stream(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()
        async with session_factory() as session2:
            run = await session2.get(Run, run_id)
            assert run is not None
            original_expiry = run.lease_expires_at

    fake = FakeProvider(
        script=[
            TextDelta(text="hi"),
            Sleep(seconds=0.3),
            Finish(finish_reason="stop"),
        ]
    )
    fast_settings = settings.model_copy(update={"worker_heartbeat_interval_seconds": 0.05})

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=fast_settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "succeeded"
        assert run.heartbeat_at is not None
        assert original_expiry is not None
        assert run.heartbeat_at >= original_expiry - timedelta(seconds=settings.run_lease_seconds)
