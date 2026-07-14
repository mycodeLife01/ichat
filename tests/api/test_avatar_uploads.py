import os
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import cast

import pytest
from fakeredis import aioredis
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.avatar import AvatarDeletion, AvatarUpload
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth import orchestration, rate_limit
from app.services.avatars.dependencies import get_avatar_api_storage
from app.services.avatars.publisher import get_avatar_task_publisher
from app.services.avatars.storage import (
    AVATAR_CONTENT_TYPE,
    FakeAvatarStorage,
    FakeAvatarTaskPublisher,
)

TEST_DATABASE_URL = os.environ.get(
    "AVATAR_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "avatar-api-test.example.com"


async def ready() -> bool:
    return True


@dataclass
class Infra:
    redis: aioredis.FakeRedis
    storage: FakeAvatarStorage = field(default_factory=FakeAvatarStorage)
    publisher: FakeAvatarTaskPublisher = field(default_factory=FakeAvatarTaskPublisher)


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def clean() -> None:
        async with factory() as session:
            user_ids = select(User.id).where(User.email.like(f"%@{TEST_DOMAIN}"))
            await session.execute(
                delete(AvatarDeletion).where(
                    AvatarDeletion.upload_id.in_(
                        select(AvatarUpload.id).where(AvatarUpload.user_id.in_(user_ids))
                    )
                )
            )
            await session.execute(delete(User).where(User.email.like(f"%@{TEST_DOMAIN}")))
            await session.execute(
                delete(EmailOutbox).where(EmailOutbox.recipient_email.like(f"%@{TEST_DOMAIN}"))
            )
            await session.commit()

    await clean()
    yield factory
    await clean()
    await engine.dispose()


@pytest.fixture()
def infra(monkeypatch: pytest.MonkeyPatch) -> Iterator[Infra]:
    handle = Infra(redis=aioredis.FakeRedis(decode_responses=True))
    monkeypatch.setattr(orchestration.send_email_outbox, "delay", lambda _outbox_id: None)
    yield handle


@pytest.fixture()
def avatar_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "avatar_storage_enabled": True,
            "avatar_public_base_url": "https://assets.test",
            "avatar_rate_user_limit": 10,
            "avatar_rate_ip_limit": 30,
        }
    )


@pytest.fixture()
async def app(
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
    avatar_settings: Settings,
) -> AsyncIterator[FastAPI]:
    application = create_app(database_ready_check=ready)

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = override_session
    application.dependency_overrides[rate_limit.get_redis] = lambda: infra.redis
    application.dependency_overrides[get_avatar_api_storage] = lambda: infra.storage
    application.dependency_overrides[get_avatar_task_publisher] = lambda: infra.publisher
    application.dependency_overrides[get_settings] = lambda: avatar_settings
    yield application
    application.dependency_overrides.clear()


@pytest.fixture()
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as value:
        yield value


async def register(client: AsyncClient, username: str = "avatar-user") -> dict[str, object]:
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "email": f"{username}@{TEST_DOMAIN}",
            "password": "correct-password",
        },
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return cast(dict[str, object], response.json()["data"])


def auth_header(data: dict[str, object]) -> dict[str, str]:
    return {"Authorization": f"Bearer {data['access_token']}"}


async def verify_user(
    session_factory: async_sessionmaker[AsyncSession], data: dict[str, object]
) -> None:
    user_id = cast(dict[str, object], data["user"])["id"]
    async with session_factory() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.email_verified = True
        await session.commit()


async def test_create_requires_verified_email(client: AsyncClient) -> None:
    data = await register(client)
    response = await client.post(
        "/api/v1/auth/me/avatar-uploads",
        headers=auth_header(data),
        json={"size_bytes": 100},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert "Verify your email" in response.json()["detail"]


async def test_create_confirm_query_and_idempotency(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client, "avatar-happy")
    await verify_user(session_factory, data)

    created = await client.post(
        "/api/v1/auth/me/avatar-uploads",
        headers=auth_header(data),
        json={"size_bytes": 7},
    )
    assert created.status_code == status.HTTP_201_CREATED, created.text
    payload = created.json()["data"]
    assert payload["upload_headers"]["Content-Type"] == AVATAR_CONTENT_TYPE
    assert payload["upload_headers"]["x-amz-meta-declared-size"] == "7"

    async with session_factory() as session:
        upload = await session.scalar(
            select(AvatarUpload).where(AvatarUpload.upload_id == payload["upload_id"])
        )
        assert upload is not None
        infra.storage.temporary[upload.temporary_object_key] = (
            b"content",
            AVATAR_CONTENT_TYPE,
            "etag-1",
        )

    confirmed = await client.post(
        f"/api/v1/auth/me/avatar-uploads/{payload['upload_id']}/confirm",
        headers=auth_header(data),
        json={"etag": '"etag-1"'},
    )
    assert confirmed.status_code == status.HTTP_200_OK
    assert confirmed.json()["data"]["status"] == "queued"
    assert infra.publisher.upload_ids == [payload["upload_id"]]

    repeated = await client.post(
        f"/api/v1/auth/me/avatar-uploads/{payload['upload_id']}/confirm",
        headers=auth_header(data),
        json={"etag": "etag-1"},
    )
    assert repeated.status_code == status.HTTP_200_OK
    assert infra.publisher.upload_ids == [payload["upload_id"]]

    queried = await client.get(
        f"/api/v1/auth/me/avatar-uploads/{payload['upload_id']}",
        headers=auth_header(data),
    )
    assert queried.status_code == status.HTTP_200_OK
    assert queried.json()["data"]["status"] == "queued"


async def test_new_upload_supersedes_previous_session(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    data = await register(client, "avatar-latest")
    await verify_user(session_factory, data)
    first = await client.post(
        "/api/v1/auth/me/avatar-uploads",
        headers=auth_header(data),
        json={"size_bytes": 10},
    )
    second = await client.post(
        "/api/v1/auth/me/avatar-uploads",
        headers=auth_header(data),
        json={"size_bytes": 11},
    )
    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_201_CREATED

    async with session_factory() as session:
        uploads = list(
            await session.scalars(
                select(AvatarUpload)
                .where(AvatarUpload.user_id == cast(dict[str, object], data["user"])["id"])
                .order_by(AvatarUpload.id)
            )
        )
    assert [upload.is_current for upload in uploads] == [False, True]
    assert uploads[0].error_code == "superseded"
