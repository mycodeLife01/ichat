import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.errors import AppError
from app.models.conversation import Conversation, Message, ShareLink
from app.models.run import Run
from app.models.user import User
from app.services.shares.service import (
    create_share,
    get_public_share,
    revoke_share,
)

TEST_DATABASE_URL = os.environ.get(
    "CONVERSATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "share-service-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    await session.execute(delete(ShareLink).where(ShareLink.conversation_id.in_(conversation_ids)))
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


async def _seed(session: AsyncSession) -> tuple[User, Conversation]:
    suffix = uuid4().hex
    user = User(
        username=f"sharer-{suffix}",
        email=f"sharer-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="shared", activated_at=datetime.now(UTC))
    session.add(conversation)
    await session.flush()

    user_message = Message(
        conversation_id=conversation.id,
        role="user",
        content="q",
        position=1,
    )
    assistant_message = Message(
        conversation_id=conversation.id,
        role="assistant",
        content="a",
        reasoning="why",
        metadata_={"sources": [{"id": 1, "title": "t", "url": "https://x.test"}]},
        position=2,
    )
    session.add_all([user_message, assistant_message])
    await session.flush()
    return user, conversation


async def test_create_share_snapshot_excludes_internal_ids(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
        )
        await session.commit()

        share = await session.scalar(
            select(ShareLink).where(ShareLink.conversation_id == conversation.id)
        )
        assert share is not None
        snapshot = share.snapshot
        assert snapshot["title"] == "shared"
        # No internal ids / positions / user identity leak into the snapshot.
        for message in snapshot["messages"]:
            assert set(message) == {"role", "content", "reasoning", "sources"}
        assert snapshot["messages"][1]["sources"][0]["url"] == "https://x.test"


async def test_create_share_sets_expiry_from_db_now(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        before = datetime.now(UTC)
        response = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=7,
        )
        await session.commit()
        assert response.expires_at is not None
        # ~7 days out, generous window for clock differences.
        assert before + timedelta(days=6) < response.expires_at < before + timedelta(days=8)


async def test_revoke_is_idempotent_and_blocks_public_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        created = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
        )
        await session.commit()

        await revoke_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            token=created.token,
        )
        await session.commit()
        # Second revoke is a no-op success.
        await revoke_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            token=created.token,
        )
        await session.commit()

        with pytest.raises(AppError) as excinfo:
            await get_public_share(session, token=created.token)
        assert excinfo.value.status_code == status.HTTP_404_NOT_FOUND


async def test_get_public_share_rejects_expired(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        created = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
        )
        share = await session.scalar(select(ShareLink).where(ShareLink.token == created.token))
        assert share is not None
        share.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

        with pytest.raises(AppError) as excinfo:
            await get_public_share(session, token=created.token)
        assert excinfo.value.status_code == status.HTTP_404_NOT_FOUND
