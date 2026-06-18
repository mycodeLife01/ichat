import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.models.user import User
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    ensure_conversation_activated,
    get_conversation_detail,
    list_conversations,
    rename_conversation,
    submit_user_message,
)

TEST_DATABASE_URL = os.environ.get(
    "CONVERSATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "conversation-service-test.example.com"


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


async def create_user(session: AsyncSession, username: str) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{username}-{suffix}",
        email=f"{username}-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def test_list_conversations_hides_drafts_and_returns_activated_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        other_user = await create_user(session, "bob")

        draft = await create_conversation(session, user=user, title=None)
        activated = await create_conversation(session, user=user, title="Project chat")
        await create_conversation(session, user=other_user, title="Other chat")
        activated_db = await session.scalar(
            select(Conversation).where(Conversation.public_id == activated.id)
        )
        assert activated_db is not None
        await ensure_conversation_activated(session, conversation_id=activated_db.id)
        await session.commit()

        conversations = await list_conversations(session, user=user)

    assert [conversation.id for conversation in conversations] == [activated.id]
    assert conversations[0].title == "Project chat"
    assert conversations[0].activated_at is not None
    assert draft.activated_at is None


async def test_get_conversation_detail_allows_owner_to_open_draft(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        draft = await create_conversation(session, user=user, title=None)
        await session.commit()

        detail = await get_conversation_detail(
            session, user=user, conversation_public_id=draft.id
        )

    assert detail.id == draft.id
    assert detail.activated_at is None
    assert detail.messages == []


async def test_deleted_conversation_detail_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = Conversation(user_id=user.id, title="Project chat")
        session.add(conversation)
        await session.flush()
        visible = Message(
            conversation_id=conversation.id,
            role="user",
            content="Hello",
            position=1,
        )
        archived = Message(
            conversation_id=conversation.id,
            role="assistant",
            content="Old answer",
            position=2,
        )
        session.add_all([visible, archived])
        await session.flush()
        await delete_conversation(
            session, user=user, conversation_public_id=conversation.public_id
        )
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await get_conversation_detail(
                session, user=user, conversation_public_id=conversation.public_id
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_get_conversation_detail_hides_archived_messages(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = Conversation(user_id=user.id, title="Project chat")
        session.add(conversation)
        await session.flush()
        visible = Message(
            conversation_id=conversation.id,
            role="user",
            content="Hello",
            position=1,
        )
        archived = Message(
            conversation_id=conversation.id,
            role="assistant",
            content="Old answer",
            position=2,
        )
        session.add_all([visible, archived])
        await session.flush()
        archived.archived_at = datetime.now(UTC)
        visible_public_id = visible.public_id
        await session.commit()

        detail = await get_conversation_detail(
            session, user=user, conversation_public_id=conversation.public_id
        )

    assert [message.id for message in detail.messages] == [visible_public_id]


async def test_rename_conversation_updates_title(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title=None)

        updated = await rename_conversation(
            session,
            user=user,
            conversation_public_id=conversation.id,
            title="  New title  ",
        )
        await session.commit()

    assert updated.title == "New title"
    assert updated.updated_at >= updated.created_at


async def test_cross_user_conversation_access_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        other_user = await create_user(session, "bob")
        conversation = await create_conversation(session, user=owner, title="Private")
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await get_conversation_detail(
                session, user=other_user, conversation_public_id=conversation.id
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_submit_user_message_creates_message_and_queued_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")

        result = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.id,
            content="Hello",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

        stored_message = await session.scalar(
            select(Message).where(Message.public_id == result.message.id)
        )
        stored_run = await session.scalar(select(Run).where(Run.public_id == result.run.id))

    assert result.message.role == "user"
    assert result.message.content == "Hello"
    assert result.message.position == 1
    assert result.message.run_id == result.run.id
    assert result.run.status == "queued"
    assert result.run.provider_name == "deepseek"
    assert result.run.provider_model == "deepseek-chat"
    assert result.run.user_message_id == result.message.id
    assert stored_message is not None
    assert stored_run is not None
    assert stored_message.run_id == stored_run.id
    assert stored_run.public_id == result.run.id
    assert stored_message.public_id == result.message.id


async def test_submit_user_message_persists_provider_options_on_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")

        result = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.id,
            content="Hello",
            provider_name="deepseek",
            provider_model="deepseek-chat",
            provider_options={"thinking_enabled": True, "reasoning_effort": "max"},
        )
        await session.commit()

        stored_run = await session.scalar(select(Run).where(Run.public_id == result.run.id))

    assert stored_run is not None
    assert stored_run.provider_options == {
        "thinking_enabled": True,
        "reasoning_effort": "max",
    }


async def test_submit_user_message_uses_next_visible_position_after_terminal_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = Conversation(user_id=user.id, title="Project chat")
        session.add(conversation)
        await session.flush()
        previous_message = Message(
            conversation_id=conversation.id,
            role="user",
            content="First",
            position=1,
        )
        session.add(previous_message)
        await session.flush()
        previous_run = Run(
            conversation_id=conversation.id,
            user_message_id=previous_message.id,
            status="succeeded",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(previous_run)
        await session.flush()
        previous_message.run_id = previous_run.id

        result = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            content="Second",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    assert result.message.position == 2


async def test_submit_user_message_rejects_active_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        first = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.id,
            content="Hello",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_public_id=conversation.id,
                content="Again",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert first.run.status == "queued"
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Active run already exists"


async def test_submit_user_message_rejects_deleted_conversation(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        await delete_conversation(
            session, user=user, conversation_public_id=conversation.id
        )

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_public_id=conversation.id,
                content="Hello",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"
