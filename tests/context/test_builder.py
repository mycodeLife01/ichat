import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.context import build_context
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.models.user import User
from app.providers import ProviderMessage

TEST_DATABASE_URL = os.environ.get(
    "CONTEXT_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "context-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
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


async def create_user(session: AsyncSession, name: str) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{name}-{suffix}",
        email=f"{name}-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def add_message(
    session: AsyncSession,
    *,
    conversation_id: int,
    role: str,
    content: str,
    position: int,
    archived: bool = False,
) -> Message:
    message = Message(
        conversation_id=conversation_id,
        role=role,
        content=content,
        position=position,
    )
    if archived:
        from datetime import UTC, datetime
        message.archived_at = datetime.now(UTC)
    session.add(message)
    await session.flush()
    return message


async def create_run_for_message(
    session: AsyncSession,
    *,
    conversation_id: int,
    user_message_id: int,
) -> Run:
    run = Run(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        status="queued",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    return run


async def test_build_context_includes_system_prompt_and_history_up_to_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "ctx-history")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="first user",
            position=1,
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="first assistant",
            position=2,
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="second user",
            position=3,
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="future assistant (must be excluded)",
            position=4,
        )
        run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        messages = await build_context(
            session,
            run_id=run.id,
            system_prompt="Be brief.",
            budget_chars=10_000,
        )

    assert [m.role for m in messages] == ["system", "user", "assistant", "user"]
    assert [m.content for m in messages] == [
        "Be brief.",
        "first user",
        "first assistant",
        "second user",
    ]


async def test_build_context_skips_archived_messages(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "ctx-archived")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="archived user",
            position=1,
            archived=True,
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="kept user",
            position=2,
        )
        run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        messages = await build_context(
            session,
            run_id=run.id,
            system_prompt="Be brief.",
            budget_chars=10_000,
        )

    assert [m.content for m in messages] == ["Be brief.", "kept user"]


async def test_build_context_truncates_oldest_history_when_over_budget(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "ctx-budget")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="oldest" * 50,
            position=1,
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="middle" * 50,
            position=2,
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="newest" * 5,
            position=3,
        )
        run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        messages = await build_context(
            session,
            run_id=run.id,
            system_prompt="sys",
            budget_chars=100,
        )

    assert messages[0] == ProviderMessage(role="system", content="sys")
    assert messages[-1].content == "newest" * 5
    assert all(m.content != "oldest" * 50 for m in messages)


async def test_build_context_raises_when_run_missing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(LookupError):
            await build_context(
                session,
                run_id=999_999_999,
                system_prompt="sys",
                budget_chars=1000,
            )
