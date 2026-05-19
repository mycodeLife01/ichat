import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.conversations import (
    ensure_conversation_activated,
    materialize_assistant_message,
)

TEST_DATABASE_URL = os.environ.get(
    "MATERIALIZE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "materialize-test.example.com"


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


async def make_run(session: AsyncSession) -> Run:
    suffix = uuid4().hex
    user = User(
        username=f"mat-{suffix}",
        email=f"mat-{suffix}@{TEST_EMAIL_DOMAIN}",
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
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await session.flush()
    return run


async def test_materialize_assistant_message_appends_assistant_with_run_link(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        run_id = run.id
        conversation_id = run.conversation_id
        await session.commit()

    async with session_factory() as session:
        message = await materialize_assistant_message(
            session,
            run_id=run_id,
            content="Hi there",
        )
        await session.commit()
        message_id = message.id

    async with session_factory() as session:
        saved = await session.get(Message, message_id)
        assert saved is not None
        assert saved.role == "assistant"
        assert saved.content == "Hi there"
        assert saved.run_id == run_id
        assert saved.conversation_id == conversation_id
        assert saved.position == 2
        conversation = await session.get(Conversation, conversation_id)
        assert conversation is not None
        assert conversation.activated_at is not None


async def test_ensure_conversation_activated_sets_timestamp_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        conversation_id = run.conversation_id
        await session.commit()

    async with session_factory() as session:
        await ensure_conversation_activated(session, conversation_id=conversation_id)
        await session.commit()

    async with session_factory() as session:
        conversation = await session.get(Conversation, conversation_id)
        assert conversation is not None
        first_activated_at = conversation.activated_at
        assert first_activated_at is not None

    async with session_factory() as session:
        await ensure_conversation_activated(session, conversation_id=conversation_id)
        await session.commit()

    async with session_factory() as session:
        conversation = await session.get(Conversation, conversation_id)
        assert conversation is not None
        assert conversation.activated_at == first_activated_at


async def test_materialize_assistant_message_rejects_unknown_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(LookupError):
            await materialize_assistant_message(
                session,
                run_id=999_999_999,
                content="hi",
            )
