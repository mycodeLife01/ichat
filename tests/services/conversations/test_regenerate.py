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
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.conversations.service import (
    edit_user_message_and_regenerate,
    regenerate_from_message,
)

TEST_DATABASE_URL = os.environ.get(
    "REGENERATE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "regenerate-service-test.example.com"


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


async def seed_conversation_with_turns(
    session: AsyncSession, *, user: User
) -> tuple[Conversation, list[Message], list[Run]]:
    """Build a conversation with two completed turns:
    user(p1) -> assistant(p2), user(p3) -> assistant(p4).
    Each turn has a succeeded run; all runs are terminal so no active run blocks.
    """
    conversation = Conversation(user_id=user.id, title="Project chat")
    session.add(conversation)
    await session.flush()

    messages: list[Message] = []
    runs: list[Run] = []
    for turn_index in range(2):
        user_position = turn_index * 2 + 1
        assistant_position = user_position + 1

        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content=f"user-turn-{turn_index}",
            position=user_position,
        )
        session.add(user_message)
        await session.flush()

        run = Run(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="deepseek",
            provider_model="deepseek-chat",
            completed_at=datetime.now(UTC),
        )
        session.add(run)
        await session.flush()
        user_message.run_id = run.id

        assistant_message = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content=f"assistant-turn-{turn_index}",
            position=assistant_position,
        )
        session.add(assistant_message)
        await session.flush()

        messages.extend([user_message, assistant_message])
        runs.append(run)

    return conversation, messages, runs


async def test_edit_user_message_archives_target_and_inserts_new_message_and_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        target = messages[2]  # user message at position 3
        assistant_after = messages[3]  # assistant at position 4
        target_db_id = target.id

        result = await edit_user_message_and_regenerate(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            message_public_id=target.public_id,
            new_content="updated user text",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    async with session_factory() as session:
        kept_first_user = await session.get(Message, messages[0].id)
        kept_first_assistant = await session.get(Message, messages[1].id)
        archived_target = await session.get(Message, target_db_id)
        archived_assistant = await session.get(Message, assistant_after.id)
        new_message = await session.scalar(
            select(Message).where(Message.public_id == result.message.id)
        )
        new_run = await session.scalar(select(Run).where(Run.public_id == result.run.id))

    assert kept_first_user is not None and kept_first_user.archived_at is None
    assert kept_first_assistant is not None and kept_first_assistant.archived_at is None
    assert archived_target is not None and archived_target.archived_at is not None
    assert archived_target.content == "user-turn-1"  # original content preserved
    assert archived_assistant is not None and archived_assistant.archived_at is not None

    assert new_message is not None
    assert new_run is not None
    assert new_message.role == "user"
    assert new_message.content == "updated user text"
    assert new_message.position == 5  # MAX(position)+1 over all rows, archived included
    assert new_message.archived_at is None
    assert new_message.run_id == new_run.id

    assert result.run.status == "queued"
    assert new_run.user_message_id == new_message.id
    assert new_run.provider_name == "deepseek"
    assert new_run.provider_model == "deepseek-chat"


async def test_edit_rejects_assistant_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        assistant_message = messages[1]

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                message_public_id=assistant_message.public_id,
                new_content="nope",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Edit target must be a user message"


async def test_edit_rejects_archived_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        messages[0].archived_at = datetime.now(UTC)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[0].public_id,
                new_content="changed",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Message not found"


async def test_edit_rejects_cross_user_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        intruder = await create_user(session, "bob")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=owner)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=intruder,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[2].public_id,
                new_content="changed",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_edit_rejects_when_active_run_exists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        # Inject a queued run for the latest turn, simulating an in-flight generation.
        active = Run(
            conversation_id=conversation.id,
            user_message_id=messages[2].id,
            status="queued",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(active)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[0].public_id,
                new_content="changed",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Active run already exists"


async def test_regenerate_from_user_message_archives_following_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        anchor = messages[2]  # user at position 3
        assistant_after = messages[3]
        first_user = messages[0]
        first_assistant = messages[1]

        result = await regenerate_from_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            message_public_id=anchor.public_id,
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    async with session_factory() as session:
        anchor_after = await session.get(Message, anchor.id)
        assistant_archived = await session.get(Message, assistant_after.id)
        kept_user = await session.get(Message, first_user.id)
        kept_assistant = await session.get(Message, first_assistant.id)
        new_run = await session.scalar(select(Run).where(Run.public_id == result.run.id))

    assert anchor_after is not None and anchor_after.archived_at is None
    assert kept_user is not None and kept_user.archived_at is None
    assert kept_assistant is not None and kept_assistant.archived_at is None
    assert assistant_archived is not None and assistant_archived.archived_at is not None

    # No new message inserted; reply will materialize when worker runs.
    assert result.message.id == anchor.public_id
    assert new_run is not None
    assert result.run.status == "queued"
    assert new_run.user_message_id == anchor.id


async def test_regenerate_from_assistant_message_resolves_to_parent_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        target_assistant = messages[3]  # assistant at position 4
        expected_user_anchor = messages[2]

        result = await regenerate_from_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            message_public_id=target_assistant.public_id,
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    async with session_factory() as session:
        anchor_after = await session.get(Message, expected_user_anchor.id)
        assistant_archived = await session.get(Message, target_assistant.id)
        new_run = await session.scalar(select(Run).where(Run.public_id == result.run.id))

    assert anchor_after is not None and anchor_after.archived_at is None
    assert assistant_archived is not None and assistant_archived.archived_at is not None
    assert new_run is not None
    assert new_run.user_message_id == expected_user_anchor.id
    assert result.message.id == expected_user_anchor.public_id


async def test_regenerate_rejects_assistant_without_run_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        messages[3].run_id = None  # corrupt the link
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[3].public_id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Cannot resolve user message to regenerate from"


async def test_regenerate_rejects_archived_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        messages[3].archived_at = datetime.now(UTC)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[3].public_id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Message not found"


async def test_regenerate_rejects_cross_user_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        intruder = await create_user(session, "bob")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=owner)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=intruder,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[3].public_id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_regenerate_rejects_when_active_run_exists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        active = Run(
            conversation_id=conversation.id,
            user_message_id=messages[2].id,
            status="streaming",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(active)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                message_public_id=messages[3].public_id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Active run already exists"
