"""Unified-avatar worker and lifecycle coverage without R2 or Celery."""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, get_settings
from app.db.sync_session import create_sync_engine
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
)
from app.models.user import User
from app.services.avatars.storage import (
    AVATAR_CONTENT_TYPE,
    FakeAvatarStorage,
    temporary_object_key,
)
from app.services.files.avatar import process_avatar_upload

TEST_DATABASE_URL = os.environ.get(
    "AVATAR_RUNTIME_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "avatar-runtime-test.example.com"


@pytest.fixture()
def session_factory() -> Iterator[sessionmaker[Session]]:
    settings = get_settings().model_copy(update={"database_url": TEST_DATABASE_URL})
    engine = create_sync_engine(settings)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        _clean(session)
        session.commit()
    yield factory
    with factory() as session:
        _clean(session)
        session.commit()
    engine.dispose()


@pytest.fixture()
def avatar_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "avatar_public_base_url": "https://assets.test",
            "avatar_processing_max_attempts": 3,
            "avatar_processing_lease_seconds": 300,
        }
    )


def _clean(session: Session) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_DOMAIN}"))
    object_ids = select(FileObject.id).where(
        FileObject.file_id.in_(select(FileAsset.id).where(FileAsset.user_id.in_(user_ids)))
    )
    session.execute(
        delete(FileObjectDeletion).where(FileObjectDeletion.file_object_id.in_(object_ids))
    )
    session.execute(delete(User).where(User.id.in_(user_ids)))


def _webp() -> bytes:
    image = Image.new("RGBA", (1024, 1024), (10, 20, 30, 120))
    output = BytesIO()
    image.save(output, format="WEBP", quality=90, lossless=True)
    return output.getvalue()


def _seed_avatar_upload(
    factory: sessionmaker[Session],
    storage: FakeAvatarStorage,
    *,
    user_id: int | None = None,
    now: datetime,
) -> tuple[int, str]:
    content = _webp()
    with factory() as session:
        if user_id is None:
            suffix = uuid4().hex
            user = User(
                username=f"avatar-{suffix}",
                email=f"avatar-{suffix}@{TEST_DOMAIN}",
                password_hash="hash",
                email_verified=True,
                is_active=True,
            )
            session.add(user)
            session.flush()
            user_id = user.id
        key = temporary_object_key()
        storage.temporary[key] = (content, AVATAR_CONTENT_TYPE, uuid4().hex)
        upload = FileUpload(
            user_id=user_id,
            purpose=FilePurpose.AVATAR,
            original_filename="avatar.webp",
            declared_content_type=AVATAR_CONTENT_TYPE,
            declared_size_bytes=len(content),
            staging_object_key=key,
            confirmed_etag=storage.temporary[key][2],
            status=FileUploadStatus.QUEUED,
            available_at=now,
            expires_at=now + timedelta(minutes=30),
        )
        session.add(upload)
        session.commit()
        return user_id, str(upload.public_id)


def test_avatar_worker_writes_only_public_avatar_asset_and_replaces_durably(
    session_factory: sessionmaker[Session], avatar_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeAvatarStorage()
    user_id, first_upload_id = _seed_avatar_upload(session_factory, storage, now=now)

    assert (
        process_avatar_upload(
            session_factory,
            upload_id=first_upload_id,
            settings=avatar_settings,
            storage=storage,
            task_id="media-1",
            now=now,
        )
        == "succeeded"
    )

    with session_factory() as session:
        user = session.get(User, user_id)
        first_upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == first_upload_id)
        )
        assert user is not None and user.avatar_file_id is not None
        assert user.avatar_object_key is None
        assert first_upload is not None and first_upload.file_id == user.avatar_file_id
        first_asset = session.get(FileAsset, user.avatar_file_id)
        assert first_asset is not None
        assert first_asset.purpose == FilePurpose.AVATAR
        assert first_asset.unbound_expires_at is None
        objects = list(
            session.scalars(select(FileObject).where(FileObject.file_id == first_asset.id))
        )
        assert len(objects) == 1
        assert objects[0].role == FileObjectRole.AVATAR_512
        assert objects[0].storage_location == FileStorageLocation.AVATAR_PUBLIC
        assert objects[0].object_key in storage.public

    _user_id, second_upload_id = _seed_avatar_upload(
        session_factory, storage, user_id=user_id, now=now + timedelta(seconds=1)
    )
    assert (
        process_avatar_upload(
            session_factory,
            upload_id=second_upload_id,
            settings=avatar_settings,
            storage=storage,
            task_id="media-2",
            now=now + timedelta(seconds=1),
        )
        == "succeeded"
    )

    with session_factory() as session:
        user = session.get(User, user_id)
        assert user is not None and user.avatar_file_id is not None
        assert user.avatar_file_id != first_asset.id
        old_asset = session.get(FileAsset, first_asset.id)
        assert old_asset is not None and old_asset.deletion_started_at is not None
        deletion = session.scalar(
            select(FileObjectDeletion).where(
                FileObjectDeletion.file_object_id == objects[0].id,
                FileObjectDeletion.storage_location == FileStorageLocation.AVATAR_PUBLIC,
            )
        )
        assert deletion is not None
        assert deletion.purge_url == f"https://assets.test/{objects[0].object_key}"
