"""HTTP contracts for the private message-attachment upload boundary."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest
from fakeredis import aioredis
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.conversation import Conversation, Message
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
    MessageAttachment,
)
from app.models.user import User
from app.services.auth import orchestration, rate_limit
from app.services.files.dependencies import get_file_download_storage, get_file_upload_storage
from app.services.files.protocols import FakeFileTaskPublisher
from app.services.files.publisher import get_file_task_publisher
from app.services.files.storage import FakeFileStorage

TEST_DATABASE_URL = os.environ.get(
    "FILE_API_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "file-api-test.example.com"


async def ready() -> bool:
    return True


@dataclass
class Infra:
    redis: aioredis.FakeRedis
    storage: FakeFileStorage = field(default_factory=FakeFileStorage)
    publisher: FakeFileTaskPublisher = field(default_factory=FakeFileTaskPublisher)


class BrokenRedis:
    def __getattr__(self, _: str) -> object:
        async def fail(*args: object, **kwargs: object) -> object:
            del args, kwargs
            raise ConnectionError("redis down")

        return fail


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def clean() -> None:
        async with factory() as session:
            await session.execute(delete(User).where(User.email.like(f"%@{TEST_DOMAIN}")))
            await session.commit()

    await clean()
    yield factory
    await clean()
    await engine.dispose()


@pytest.fixture()
def infra(monkeypatch: pytest.MonkeyPatch) -> Iterator[Infra]:
    value = Infra(redis=aioredis.FakeRedis(decode_responses=True))
    monkeypatch.setattr(orchestration.send_email_outbox, "delay", lambda _outbox_id: None)
    yield value


@pytest.fixture()
def file_settings() -> Settings:
    # model_copy intentionally skips external-service validation; all R2 calls
    # are replaced with the explicit fake adapter below.
    return get_settings().model_copy(
        update={
            "file_upload_enabled": True,
            "files_rate_user_limit": 10,
            "files_rate_ip_limit": 30,
            "files_max_inflight_uploads": 5,
        }
    )


@pytest.fixture()
async def app(
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
    file_settings: Settings,
) -> AsyncIterator[FastAPI]:
    application = create_app(database_ready_check=ready)

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = override_session
    application.dependency_overrides[rate_limit.get_redis] = lambda: infra.redis
    application.dependency_overrides[get_file_upload_storage] = lambda: infra.storage
    application.dependency_overrides[get_file_download_storage] = lambda: infra.storage
    application.dependency_overrides[get_file_task_publisher] = lambda: infra.publisher
    application.dependency_overrides[get_settings] = lambda: file_settings
    yield application
    application.dependency_overrides.clear()


@pytest.fixture()
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as value:
        yield value


async def register(client: AsyncClient, username: str = "file-user") -> dict[str, Any]:
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "email": f"{username}@{TEST_DOMAIN}",
            "password": "correct-password",
        },
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return cast(dict[str, Any], response.json()["data"])


def auth_header(data: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {data['access_token']}"}


async def verify_user(
    session_factory: async_sessionmaker[AsyncSession], data: dict[str, Any]
) -> None:
    async with session_factory() as session:
        user = await session.get(User, data["user"]["id"])
        assert user is not None
        user.email_verified = True
        await session.commit()


async def create_upload(client: AsyncClient, data: dict[str, Any]) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/files/uploads",
        headers=auth_header(data),
        json={"filename": "notes.txt", "content_type": "text/plain", "size_bytes": 12},
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return cast(dict[str, Any], response.json()["data"])


async def test_create_requires_verified_email(client: AsyncClient) -> None:
    data = await register(client)

    response = await client.post(
        "/api/v1/files/uploads",
        headers=auth_header(data),
        json={"filename": "notes.txt", "content_type": "text/plain", "size_bytes": 12},
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert response.json()["detail"] == "Verify your email before uploading files"


async def test_create_confirm_query_cancel_and_ownership(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    owner = await register(client, "file-owner")
    other = await register(client, "file-other")
    await verify_user(session_factory, owner)
    await verify_user(session_factory, other)

    created = await create_upload(client, owner)
    assert created["status"] == "pending"
    assert created["upload_headers"] == {
        "Content-Type": "text/plain",
        "x-amz-meta-declared-size": "12",
    }
    assert "file-owner" not in created["upload_url"]
    key = created["upload_url"].split("upload.invalid/")[1].split("?", 1)[0]
    etag = infra.storage.put_staging(
        key,
        b"hello world!",
        content_type="text/plain",
        declared_size_bytes=12,
    )

    foreign_get = await client.get(
        f"/api/v1/files/uploads/{created['upload_id']}", headers=auth_header(other)
    )
    assert foreign_get.status_code == status.HTTP_404_NOT_FOUND

    confirmed = await client.post(
        f"/api/v1/files/uploads/{created['upload_id']}/confirm",
        headers=auth_header(owner),
        json={"etag": f'"{etag}"'},
    )
    assert confirmed.status_code == status.HTTP_200_OK, confirmed.text
    assert confirmed.json()["data"]["status"] == "queued"
    assert infra.publisher.upload_ids == [created["upload_id"]]

    repeated = await client.post(
        f"/api/v1/files/uploads/{created['upload_id']}/confirm",
        headers=auth_header(owner),
        json={"etag": etag},
    )
    assert repeated.status_code == status.HTTP_200_OK
    assert repeated.json()["data"]["status"] == "queued"
    assert infra.publisher.upload_ids == [created["upload_id"]]

    mismatched_repeat = await client.post(
        f"/api/v1/files/uploads/{created['upload_id']}/confirm",
        headers=auth_header(owner),
        json={"etag": "replacement"},
    )
    assert mismatched_repeat.status_code == status.HTTP_409_CONFLICT

    batch = await client.post(
        "/api/v1/files/uploads/status",
        headers=auth_header(owner),
        json={"upload_ids": [created["upload_id"]]},
    )
    assert batch.status_code == status.HTTP_200_OK
    assert batch.json()["data"] == [confirmed.json()["data"]]

    cancelled = await client.delete(
        f"/api/v1/files/uploads/{created['upload_id']}", headers=auth_header(owner)
    )
    assert cancelled.status_code == status.HTTP_200_OK
    assert cancelled.json()["data"]["status"] == "cancelled"
    again = await client.delete(
        f"/api/v1/files/uploads/{created['upload_id']}", headers=auth_header(owner)
    )
    assert again.status_code == status.HTTP_200_OK
    assert again.json()["data"]["status"] == "cancelled"


async def test_cancel_waits_for_concurrent_binding_and_rejects_bound_asset(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    data = await register(client, "file-cancel-binding-race")
    await verify_user(session_factory, data)
    now = datetime.now(UTC)
    async with session_factory() as setup_session:
        user = await setup_session.get(User, data["user"]["id"])
        assert user is not None
        asset = FileAsset(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="notes.txt",
            media_type="text/plain",
            size_bytes=5,
            sha256="c" * 64,
            document_text="notes",
            model_consumable=True,
            unbound_expires_at=now + timedelta(days=1),
        )
        setup_session.add(asset)
        await setup_session.flush()
        upload = FileUpload(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="notes.txt",
            declared_content_type="text/plain",
            declared_size_bytes=5,
            staging_object_key=f"staging/{asset.public_id}",
            status=FileUploadStatus.SUCCEEDED,
            available_at=now,
            expires_at=now + timedelta(minutes=30),
            completed_at=now,
            file_id=asset.id,
        )
        setup_session.add(upload)
        await setup_session.commit()
        upload_id = upload.public_id
        asset_id = asset.id

    async with session_factory() as binding_session:
        locked_asset = await binding_session.scalar(
            select(FileAsset).where(FileAsset.id == asset_id).with_for_update()
        )
        assert locked_asset is not None
        locked_asset.bound_at = now
        await binding_session.flush()

        cancel_task = asyncio.create_task(
            client.delete(
                f"/api/v1/files/uploads/{upload_id}",
                headers=auth_header(data),
            )
        )
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(cancel_task), timeout=0.1)

        await binding_session.commit()
        response = await asyncio.wait_for(cancel_task, timeout=5)

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["detail"] == "A bound attachment cannot be cancelled"
    async with session_factory() as verification_session:
        persisted = await verification_session.get(FileAsset, asset_id)
        assert persisted is not None
        assert persisted.bound_at == now
        assert persisted.deletion_started_at is None


@pytest.mark.parametrize(
    ("actual_content", "actual_type", "declared_size", "etag"),
    [
        (b"short", "text/plain", 5, "correct"),
        (b"hello world!", "text/plain", None, "correct"),
        (b"hello world!", "application/json", 12, "correct"),
        (b"hello world!", "text/plain", 12, "wrong"),
    ],
)
async def test_confirm_rejects_staging_metadata_mismatch_without_consuming_reservation(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
    actual_content: bytes,
    actual_type: str,
    declared_size: int | None,
    etag: str,
) -> None:
    data = await register(client, f"file-mismatch-{actual_type.split('/')[-1]}-{etag}")
    await verify_user(session_factory, data)
    created = await create_upload(client, data)
    key = created["upload_url"].split("upload.invalid/")[1].split("?", 1)[0]
    real_etag = infra.storage.put_staging(
        key,
        actual_content,
        content_type=actual_type,
        declared_size_bytes=declared_size,
    )
    sent_etag = real_etag if etag == "correct" else etag

    response = await client.post(
        f"/api/v1/files/uploads/{created['upload_id']}/confirm",
        headers=auth_header(data),
        json={"etag": sent_etag},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.json()["detail"] == "File upload could not be verified"
    async with session_factory() as session:
        # A failed confirm must leave the session retryable and its quota
        # reservation intact; otherwise attackers can bypass the admission lock.
        response_row = await session.execute(
            select(User).where(User.id == data["user"]["id"])
        )
        assert response_row.scalar_one() is not None
        status_response = await client.get(
            f"/api/v1/files/uploads/{created['upload_id']}", headers=auth_header(data)
        )
        assert status_response.json()["data"]["status"] == "pending"


async def test_create_fails_closed_when_redis_is_down(
    app: FastAPI,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    data = await register(client, "file-redis-down")
    await verify_user(session_factory, data)
    app.dependency_overrides[rate_limit.get_redis] = lambda: BrokenRedis()

    response = await client.post(
        "/api/v1/files/uploads",
        headers=auth_header(data),
        json={"filename": "notes.txt", "content_type": "text/plain", "size_bytes": 12},
    )

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert response.json()["detail"] == "File upload is temporarily unavailable"


async def test_read_url_requires_active_account_and_visible_non_deleted_message(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client, "file-read-permission")
    other = await register(client, "file-read-other")
    await verify_user(session_factory, data)
    async with session_factory() as session:
        user = await session.get(User, data["user"]["id"])
        assert user is not None
        conversation = Conversation(user_id=user.id, title="Attachment")
        session.add(conversation)
        await session.flush()
        message = Message(
            conversation_id=conversation.id,
            role="user",
            content="read this",
            position=1,
        )
        session.add(message)
        await session.flush()
        asset = FileAsset(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="notes.txt",
            media_type="text/plain",
            size_bytes=5,
            sha256="b" * 64,
            document_text="notes",
            model_consumable=True,
            bound_at=datetime.now(UTC),
        )
        session.add(asset)
        await session.flush()
        key = f"files/{asset.public_id}/original"
        session.add(
            FileObject(
                file_id=asset.id,
                role=FileObjectRole.ORIGINAL,
                storage_location=FileStorageLocation.CANONICAL_PRIVATE,
                object_key=key,
                media_type="text/plain",
                size_bytes=5,
                sha256="b" * 64,
            )
        )
        session.add(
            MessageAttachment(
                message_id=message.id,
                file_id=asset.id,
                position=0,
                name="notes.txt",
                media_type="text/plain",
                size_bytes=5,
            )
        )
        await session.commit()
        asset_id = str(asset.public_id)
        conversation_id = conversation.id
    infra.storage.put_canonical(key, content=b"notes", content_type="text/plain")

    readable = await client.post(
        f"/api/v1/files/{asset_id}/read-url",
        headers=auth_header(data),
        json={"role": "download"},
    )
    assert readable.status_code == status.HTTP_200_OK
    assert readable.json()["data"]["url"].startswith("https://download.invalid/files/")

    foreign = await client.post(
        f"/api/v1/files/{asset_id}/read-url",
        headers=auth_header(other),
        json={"role": "download"},
    )
    assert foreign.status_code == status.HTTP_404_NOT_FOUND

    async with session_factory() as session:
        conversation = await session.get(Conversation, conversation_id)
        assert conversation is not None
        conversation.deleted_at = datetime.now(UTC)
        await session.commit()

    deleted = await client.post(
        f"/api/v1/files/{asset_id}/read-url",
        headers=auth_header(data),
        json={"role": "download"},
    )
    assert deleted.status_code == status.HTTP_404_NOT_FOUND

    async with session_factory() as session:
        user = await session.get(User, data["user"]["id"])
        assert user is not None
        user.is_active = False
        await session.commit()

    inactive = await client.post(
        f"/api/v1/files/{asset_id}/read-url",
        headers=auth_header(data),
        json={"role": "download"},
    )
    assert inactive.status_code == status.HTTP_401_UNAUTHORIZED
