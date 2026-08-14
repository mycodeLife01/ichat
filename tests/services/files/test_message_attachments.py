"""Attachment binding, revisions, and transcript facts at the service seam."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.messages import DocumentBlock
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.files import FileAsset, FileModelInputKind, FilePurpose, MessageAttachment
from app.models.run import Run, RunProviderMessage
from app.models.user import User
from app.services.conversations.service import (
    delete_conversation,
    edit_user_message_and_regenerate,
    list_deleted_conversations,
    regenerate_from_message,
    restore_conversation,
    submit_user_message,
)
from app.services.runs.history import load_conversation_history

TEST_DATABASE_URL = os.environ.get(
    "FILE_MESSAGE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "file-message-test.example.com"


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def clean() -> None:
        async with factory() as session:
            user_ids = select(User.id).where(User.email.like(f"%@{TEST_DOMAIN}"))
            conversation_ids = select(Conversation.id).where(
                Conversation.user_id.in_(user_ids)
            )
            await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
            await session.execute(
                delete(Message).where(Message.conversation_id.in_(conversation_ids))
            )
            await session.execute(delete(User).where(User.id.in_(user_ids)))
            await session.commit()

    await clean()
    yield factory
    await clean()
    await engine.dispose()


@pytest.fixture()
def file_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "context_budget_tokens": 256_000,
            "attachment_target_turn_tokens": 128_000,
            "files_max_attachments_per_message": 5,
            "files_max_message_bytes": 50 * 1024 * 1024,
        }
    )


async def _user(session: AsyncSession, name: str, *, active: bool = True) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{name}-{suffix}",
        email=f"{name}-{suffix}@{TEST_DOMAIN}",
        password_hash="hash",
        email_verified=True,
        is_active=active,
    )
    session.add(user)
    await session.flush()
    return user


async def _conversation(session: AsyncSession, user: User) -> Conversation:
    conversation = Conversation(user_id=user.id, title="Files")
    session.add(conversation)
    await session.flush()
    return conversation


async def _asset(
    session: AsyncSession,
    user: User,
    *,
    name: str = "notes.txt",
    media_type: str = "text/plain",
    size_bytes: int = 16,
    text: str | None = "full document text",
    now: datetime,
) -> FileAsset:
    asset = FileAsset(
        user_id=user.id,
        purpose=FilePurpose.MESSAGE_ATTACHMENT,
        original_filename=name,
        media_type=media_type,
        size_bytes=size_bytes,
        sha256="a" * 64,
        document_text=text,
        model_input_kind=FileModelInputKind.DOCUMENT if text is not None else None,
        extractor_version="files-v1" if text is not None else None,
        summary_metadata={"pages": 1} if text is not None else None,
        unbound_expires_at=now + timedelta(days=1),
    )
    session.add(asset)
    await session.flush()
    return asset


async def test_invalid_attachment_rolls_back_message_run_and_binding_atomically(
    session_factory: async_sessionmaker[AsyncSession], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    async with session_factory() as session:
        owner = await _user(session, "owner")
        stranger = await _user(session, "stranger")
        conversation = await _conversation(session, owner)
        allowed = await _asset(session, owner, now=now)
        forbidden = await _asset(session, stranger, now=now)

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=owner,
                conversation_public_id=conversation.public_id,
                content="Please compare these",
                attachment_ids=[allowed.public_id, forbidden.public_id],
                provider_name="fake",
                provider_model="fake",
                settings=file_settings,
                count_tokens=len,
            )

        assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert exc_info.value.detail == "One or more attachments are unavailable"
        assert (
            await session.scalar(
                select(Message.id).where(Message.conversation_id == conversation.id)
            )
        ) is None
        assert (
            await session.scalar(select(Run.id).where(Run.conversation_id == conversation.id))
        ) is None
        assert allowed.bound_at is None
        assert allowed.unbound_expires_at == now + timedelta(days=1)


async def test_inactive_owner_cannot_bind_a_ready_attachment(
    session_factory: async_sessionmaker[AsyncSession], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    async with session_factory() as session:
        user = await _user(session, "inactive-binding")
        conversation = await _conversation(session, user)
        asset = await _asset(session, user, now=now)
        user.is_active = False
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                content="Use the attachment",
                attachment_ids=[asset.public_id],
                provider_name="fake",
                provider_model="fake",
                settings=file_settings,
                count_tokens=len,
            )

        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert asset.bound_at is None
        assert (
            await session.scalar(
                select(Message.id).where(Message.conversation_id == conversation.id)
            )
            is None
        )


async def test_document_only_turn_is_snapshotted_and_history_never_needs_file_storage(
    session_factory: async_sessionmaker[AsyncSession], file_settings: Settings
) -> None:
    now = datetime.now(UTC)
    async with session_factory() as session:
        user = await _user(session, "snapshot")
        conversation = await _conversation(session, user)
        asset = await _asset(session, user, text="confidential report body", now=now)

        result = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            content="",
            attachment_ids=[asset.public_id],
            provider_name="fake",
            provider_model="fake",
            settings=file_settings,
            count_tokens=len,
        )
        run = await session.scalar(select(Run).where(Run.public_id == result.run.id))
        assert run is not None
        transcript = list(
            (
                await session.scalars(
                    select(RunProviderMessage)
                    .where(RunProviderMessage.run_id == run.id)
                    .order_by(RunProviderMessage.seq)
                )
            ).all()
        )
        assert len(transcript) == 1
        assert transcript[0].blocks is not None
        assert transcript[0].blocks[0]["type"] == "document"
        assert transcript[0].blocks[0]["text"] == "confidential report body"
        assert result.message.content == ""

        # This models a future detached-file purge / unavailable R2, not a normal
        # current-revision mutation. The persisted transcript remains the fact
        # that the provider saw during the original run.
        await session.delete(asset)
        await session.commit()

        history = await load_conversation_history(session, run_id=run.id)

    assert len(history) == 1
    block = history[0].blocks[0]
    assert isinstance(block, DocumentBlock)
    assert block.text == "confidential report body"
    assert block.extractor_version == "files-v1"


async def test_display_only_image_requires_text_and_becomes_a_notice_when_sent(
    session_factory: async_sessionmaker[AsyncSession], file_settings: Settings
) -> None:
    now = datetime.now(UTC)
    async with session_factory() as session:
        user = await _user(session, "image")
        conversation = await _conversation(session, user)
        image = await _asset(
            session,
            user,
            name="photo.png",
            media_type="image/png",
            text=None,
            now=now,
        )

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                content="",
                attachment_ids=[image.public_id],
                provider_name="fake",
                provider_model="fake",
                settings=file_settings,
                count_tokens=len,
            )
        assert exc_info.value.detail == "Enter a message or attach a readable file"

        result = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            content="What should I check in this image?",
            attachment_ids=[image.public_id],
            provider_name="fake",
            provider_model="fake",
            settings=file_settings,
            count_tokens=len,
        )
        run = await session.scalar(select(Run).where(Run.public_id == result.run.id))
        assert run is not None
        transcript = await session.scalar(
            select(RunProviderMessage).where(RunProviderMessage.run_id == run.id)
        )
        assert transcript is not None and transcript.blocks is not None
        await session.commit()

    assert transcript.blocks[1]["type"] == "attachment_notice"
    assert transcript.blocks[1]["filename"] == "photo.png"
    assert "data" not in transcript.blocks[1]
    assert "url" not in transcript.blocks[1]


async def test_target_turn_budget_rejection_does_not_bind_or_create_a_run(
    session_factory: async_sessionmaker[AsyncSession], file_settings: Settings
) -> None:
    now = datetime.now(UTC)
    tiny_budget = file_settings.model_copy(
        update={"attachment_target_turn_tokens": 4, "context_budget_tokens": 8}
    )
    async with session_factory() as session:
        user = await _user(session, "budget")
        conversation = await _conversation(session, user)
        asset = await _asset(session, user, text="document must not truncate", now=now)

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                content="",
                attachment_ids=[asset.public_id],
                provider_name="fake",
                provider_model="fake",
                settings=tiny_budget,
                count_tokens=len,
            )

        assert exc_info.value.status_code == status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
        assert exc_info.value.detail == "Attachments exceed the model context budget"
        assert asset.bound_at is None
        assert (
            await session.scalar(
                select(Message.id).where(Message.conversation_id == conversation.id)
            )
        ) is None


async def test_edit_inherits_then_explicit_empty_detaches_and_regenerate_reuses_input(
    session_factory: async_sessionmaker[AsyncSession], file_settings: Settings
) -> None:
    now = datetime.now(UTC)
    async with session_factory() as session:
        user = await _user(session, "revisions")
        conversation = await _conversation(session, user)
        asset = await _asset(session, user, text="fixed source text", now=now)
        initial = await submit_user_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            content="original",
            attachment_ids=[asset.public_id],
            provider_name="fake",
            provider_model="fake",
            settings=file_settings,
            count_tokens=len,
        )
        first_run = await session.scalar(select(Run).where(Run.public_id == initial.run.id))
        assert first_run is not None
        first_run.status = "succeeded"

        inherited = await edit_user_message_and_regenerate(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            message_public_id=initial.message.id,
            new_content="edited",
            attachment_ids=None,
            provider_name="fake",
            provider_model="fake",
            settings=file_settings,
            count_tokens=len,
        )
        inherited_run = await session.scalar(select(Run).where(Run.public_id == inherited.run.id))
        assert inherited_run is not None
        inherited_run.status = "succeeded"
        inherited_message = await session.scalar(
            select(Message).where(Message.public_id == inherited.message.id)
        )
        assert inherited_message is not None
        assert await session.scalar(
            select(MessageAttachment.id).where(MessageAttachment.message_id == inherited_message.id)
        ) is not None
        assert asset.detached_at is None

        regenerated = await regenerate_from_message(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            message_public_id=inherited.message.id,
            provider_name="fake",
            provider_model="fake",
            settings=file_settings,
            count_tokens=len,
        )
        regen_run = await session.scalar(select(Run).where(Run.public_id == regenerated.run.id))
        assert regen_run is not None
        regen_transcript = await session.scalar(
            select(RunProviderMessage).where(RunProviderMessage.run_id == regen_run.id)
        )
        assert regen_transcript is not None and regen_transcript.blocks is not None
        assert regen_transcript.blocks[1]["type"] == "document"
        assert regen_transcript.blocks[1]["file_id"] == str(asset.public_id)
        regen_run.status = "succeeded"

        removed = await edit_user_message_and_regenerate(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            message_public_id=inherited.message.id,
            new_content="text without attachment",
            attachment_ids=[],
            provider_name="fake",
            provider_model="fake",
            settings=file_settings,
            count_tokens=len,
        )
        removed_message = await session.scalar(
            select(Message).where(Message.public_id == removed.message.id)
        )
        assert removed_message is not None
        assert (
            await session.scalar(
                select(MessageAttachment.id).where(
                    MessageAttachment.message_id == removed_message.id
                )
            )
        ) is None
        assert asset.detached_at is not None
        await session.commit()


async def test_deleted_conversation_preserves_attachment_until_restored_or_purged(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    async with session_factory() as session:
        user = await _user(session, "restore")
        conversation = await _conversation(session, user)
        message = Message(
            conversation_id=conversation.id,
            role="user",
            content="keep attachment",
            position=1,
        )
        session.add(message)
        await session.flush()
        asset = await _asset(session, user, now=now)
        asset.bound_at = now
        session.add(
            MessageAttachment(
                message_id=message.id,
                file_id=asset.id,
                position=0,
                name=asset.original_filename,
                media_type=asset.media_type,
                size_bytes=asset.size_bytes,
            )
        )
        await session.flush()

        await delete_conversation(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
        )
        await session.commit()

        deleted = await list_deleted_conversations(session, user=user)
        assert [item.id for item in deleted] == [conversation.public_id]
        assert deleted[0].deletion_due_at is not None
        assert asset.deletion_started_at is None

        restored = await restore_conversation(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
        )
        await session.commit()
        assert restored.deleted_at is None
        assert restored.deletion_due_at is None
        assert asset.deletion_started_at is None

        conversation.deleted_at = datetime.now(UTC) - timedelta(days=31)
        conversation.deletion_due_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.flush()
        with pytest.raises(AppError) as exc_info:
            await restore_conversation(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
            )

    assert exc_info.value.status_code == status.HTTP_410_GONE
