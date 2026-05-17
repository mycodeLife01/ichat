import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Finish, Provider, TextDelta
from app.services.runs.lifecycle import claim_next_queued_run
from app.worker.executor import execute_run
from tests.providers.fake import FakeProvider

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


from app.worker.executor import ProviderResolver


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
            "text_delta",
            "run_succeeded",
        ]
        assert events[1].payload == {"text": "Hello"}
        assert events[2].payload == {"text": " world"}

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
