import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import uuid4

import pytest
from fakeredis import aioredis
from fastapi import status
from redis.asyncio import Redis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.errors import AppError
from app.models.conversation import Conversation, Message, ShareLink
from app.models.files import (
    FileAsset,
    FileModelInputKind,
    FileObject,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
    MessageAttachment,
)
from app.models.run import Run
from app.models.user import User
from app.services.files.storage import FakeFileStorage
from app.services.shares.service import (
    create_share,
    get_public_share,
    get_public_share_attachment_read_url,
    guard_public_read_rate_limit,
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
    file_ids = select(FileAsset.id).where(FileAsset.user_id.in_(user_ids)).scalar_subquery()
    await session.execute(delete(ShareLink).where(ShareLink.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(FileObject).where(FileObject.file_id.in_(file_ids)))
    await session.execute(delete(FileAsset).where(FileAsset.user_id.in_(user_ids)))
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
            assert set(message) == {"role", "content", "reasoning", "sources", "attachments"}
            assert message["attachments"] == []
        assert snapshot["messages"][1]["sources"][0]["url"] == "https://x.test"


async def test_inactive_user_cannot_create_a_share(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        user.is_active = False
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await create_share(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                expires_in_days=None,
        )

        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert (
            await session.scalar(
                select(ShareLink.id).where(ShareLink.conversation_id == conversation.id)
            )
            is None
        )


async def test_attachment_share_requires_confirmation_and_freezes_only_placeholders(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        user_message = await session.scalar(
            select(Message).where(
                Message.conversation_id == conversation.id,
                Message.role == "user",
            )
        )
        assert user_message is not None
        session.add(
            MessageAttachment(
                message_id=user_message.id,
                file_id=None,
                position=0,
                name="research.pdf",
                media_type="application/pdf",
                size_bytes=1234,
                warnings=["partial_content_not_extracted"],
            )
        )
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await create_share(
                session,
                user=user,
                conversation_public_id=conversation.public_id,
                expires_in_days=None,
            )
        assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert "Confirm that assistant replies" in exc_info.value.detail

        created = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
            confirm_attachment_privacy=True,
        )
        await session.commit()
        share = await session.scalar(select(ShareLink).where(ShareLink.token == created.token))
        assert share is not None
        placeholder = share.snapshot["messages"][0]["attachments"][0]
        assert placeholder == {
            "name": "research.pdf",
            "media_type": "application/pdf",
            "size_bytes": 1234,
            "category": "pdf",
            "warnings": ["partial_content_not_extracted"],
            "position": 0,
            "model_input_kind": None,
            "preview_available": False,
            "stats": {},
        }
        # A reclaimed asset (file_id NULL) stays metadata-only: without a ref
        # there is no read path at all.
        assert "file_id" not in placeholder
        assert "ref" not in placeholder
        assert "object_key" not in placeholder

        public = await get_public_share(session, token=created.token)

    assert public.messages[0].attachments[0].name == "research.pdf"
    assert public.messages[0].attachments[0].warnings == ["partial_content_not_extracted"]
    assert public.messages[0].attachments[0].ref is None


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


async def _bound_image_attachment(
    session: AsyncSession,
    user: User,
    conversation: Conversation,
) -> FileAsset:
    """Attach a bound image asset with original + preview objects."""
    now = datetime.now(UTC)
    asset = FileAsset(
        user_id=user.id,
        purpose=FilePurpose.MESSAGE_ATTACHMENT,
        original_filename="diagram.png",
        media_type="image/png",
        size_bytes=2048,
        sha256="b" * 64,
        model_input_kind=FileModelInputKind.IMAGE,
        summary_metadata={"width": 800, "height": 400, "pages": 1},
        bound_at=now,
    )
    session.add(asset)
    await session.flush()
    session.add_all(
        [
            FileObject(
                file_id=asset.id,
                role=FileObjectRole.ORIGINAL,
                storage_location=FileStorageLocation.CANONICAL_PRIVATE,
                object_key=f"canonical/{asset.public_id}",
                size_bytes=asset.size_bytes,
                media_type=asset.media_type,
                sha256=asset.sha256,
            ),
            FileObject(
                file_id=asset.id,
                role=FileObjectRole.PREVIEW,
                storage_location=FileStorageLocation.MODEL_PREVIEW_PRIVATE,
                object_key=f"preview/{asset.public_id}",
                size_bytes=asset.size_bytes,
                media_type=asset.media_type,
                sha256=asset.sha256,
            ),
        ]
    )
    user_message = await session.scalar(
        select(Message).where(
            Message.conversation_id == conversation.id,
            Message.role == "user",
        )
    )
    assert user_message is not None
    session.add(
        MessageAttachment(
            message_id=user_message.id,
            file_id=asset.id,
            position=0,
            name=asset.original_filename,
            media_type=asset.media_type,
            size_bytes=asset.size_bytes,
        )
    )
    await session.flush()
    return asset


def _read_storage(asset: FileAsset) -> FakeFileStorage:
    storage = FakeFileStorage()
    storage.put_canonical(
        f"canonical/{asset.public_id}", content=b"original", content_type="image/png"
    )
    storage.put_preview(
        f"preview/{asset.public_id}", content=b"preview", content_type="image/png"
    )
    return storage


async def test_snapshot_keeps_file_id_private_and_exposes_only_a_ref(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        asset = await _bound_image_attachment(session, user, conversation)
        created = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
            confirm_attachment_privacy=True,
        )
        await session.commit()

        share = await session.scalar(select(ShareLink).where(ShareLink.token == created.token))
        assert share is not None
        stored = share.snapshot["messages"][0]["attachments"][0]
        assert stored["ref"] == "0-0"
        assert stored["file_id"] == str(asset.public_id)
        # Only geometry is copied — derived document metadata stays out.
        assert stored["stats"] == {"width": 800, "height": 400}

        public = await get_public_share(session, token=created.token)
        attachment = public.messages[0].attachments[0]
        assert attachment.ref == "0-0"
        assert attachment.preview_available is True
        assert attachment.stats == {"width": 800, "height": 400}
        # The public schema must not carry the file id in any form.
        assert "file_id" not in attachment.model_dump()
        assert str(asset.public_id) not in str(attachment.model_dump())


async def test_public_attachment_read_signs_preview_and_download(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        asset = await _bound_image_attachment(session, user, conversation)
        created = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
            confirm_attachment_privacy=True,
        )
        await session.commit()
        storage = _read_storage(asset)
        settings = get_settings()

        preview = await get_public_share_attachment_read_url(
            session,
            storage,
            token=created.token,
            ref="0-0",
            role="preview",
            settings=settings,
            preview_storage=storage,
        )
        assert preview.url.startswith("https://preview.invalid/")

        download = await get_public_share_attachment_read_url(
            session,
            storage,
            token=created.token,
            ref="0-0",
            role="download",
            settings=settings,
            preview_storage=storage,
        )
        assert download.url.startswith("https://download.invalid/")

        # An unknown ref cannot be probed into a URL.
        with pytest.raises(AppError) as excinfo:
            await get_public_share_attachment_read_url(
                session,
                storage,
                token=created.token,
                ref="9-9",
                role="preview",
                settings=settings,
                preview_storage=storage,
            )
        assert excinfo.value.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.parametrize(
    "revoke_kind",
    ["revoked", "expired", "conversation_deleted", "owner_deactivated", "asset_deleted"],
)
async def test_public_attachment_read_is_revoked_by_every_lifecycle_change(
    session_factory: async_sessionmaker[AsyncSession],
    revoke_kind: str,
) -> None:
    async with session_factory() as session:
        user, conversation = await _seed(session)
        asset = await _bound_image_attachment(session, user, conversation)
        created = await create_share(
            session,
            user=user,
            conversation_public_id=conversation.public_id,
            expires_in_days=None,
            confirm_attachment_privacy=True,
        )
        await session.flush()
        share = await session.scalar(select(ShareLink).where(ShareLink.token == created.token))
        assert share is not None
        now = datetime.now(UTC)
        if revoke_kind == "revoked":
            share.revoked_at = now
        elif revoke_kind == "expired":
            share.expires_at = now - timedelta(seconds=1)
        elif revoke_kind == "conversation_deleted":
            conversation.deleted_at = now
        elif revoke_kind == "owner_deactivated":
            user.is_active = False
        else:
            asset.deletion_started_at = now
        await session.commit()

        with pytest.raises(AppError) as excinfo:
            await get_public_share_attachment_read_url(
                session,
                _read_storage(asset),
                token=created.token,
                ref="0-0",
                role="preview",
                settings=get_settings(),
                preview_storage=_read_storage(asset),
            )
        assert excinfo.value.status_code == status.HTTP_404_NOT_FOUND


class _BrokenRedis:
    """Stands in for an unreachable Redis so the guard's failure policy shows."""

    async def eval(self, *args: object, **kwargs: object) -> object:
        raise ConnectionError("redis is down")


async def test_read_rate_limit_throttles_per_token_and_fails_closed() -> None:
    redis = aioredis.FakeRedis(decode_responses=True)

    settings = get_settings().model_copy(
        update={
            "share_read_token_download_limit": 2,
            "share_read_token_download_window_seconds": 60,
            "share_read_ip_limit": 100,
        }
    )
    for _ in range(2):
        await guard_public_read_rate_limit(
            redis,
            token="tok",
            role="download",
            client_ip="203.0.113.9",
            settings=settings,
        )
    with pytest.raises(AppError) as excinfo:
        await guard_public_read_rate_limit(
            redis,
            token="tok",
            role="download",
            client_ip="203.0.113.9",
            settings=settings,
        )
    assert excinfo.value.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert excinfo.value.headers is not None
    assert "Retry-After" in excinfo.value.headers

    # A second token is unaffected by the first token's exhausted budget.
    await guard_public_read_rate_limit(
        redis,
        token="other",
        role="download",
        client_ip="203.0.113.9",
        settings=settings,
    )

    await redis.aclose()
    # Redis being unavailable must fail closed, never open.
    with pytest.raises(AppError) as excinfo:
        await guard_public_read_rate_limit(
            cast(Redis, _BrokenRedis()),
            token="tok",
            role="preview",
            client_ip="203.0.113.9",
            settings=settings,
        )
    assert excinfo.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
