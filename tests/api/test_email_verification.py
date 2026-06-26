"""API tests for email verification endpoints.

Requires PostgreSQL. Redis is replaced with fakeredis and the Celery enqueue is
captured, so these run without external services beyond the database.
"""

import os
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import cast
from urllib.parse import parse_qs, urlparse

import pytest
from fakeredis import aioredis
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.api.v1.auth as auth_routes
from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.auth_token import AuthToken
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth import rate_limit

TEST_DATABASE_URL = os.environ.get(
    "EMAIL_VERIFY_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "email-verify-api-test.example.com"


async def ready() -> bool:
    return True


@dataclass
class Infra:
    redis: aioredis.FakeRedis
    enqueued: list[int] = field(default_factory=list)


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _clean() -> None:
        async with factory() as s:
            await s.execute(delete(User).where(User.email.like(f"%@{TEST_DOMAIN}")))
            await s.execute(
                delete(EmailOutbox).where(EmailOutbox.recipient_email.like(f"%@{TEST_DOMAIN}"))
            )
            await s.commit()

    await _clean()
    yield factory
    await _clean()
    await engine.dispose()


@pytest.fixture()
def infra(monkeypatch: pytest.MonkeyPatch) -> Iterator[Infra]:
    handle = Infra(redis=aioredis.FakeRedis(decode_responses=True))
    monkeypatch.setattr(rate_limit, "get_redis", lambda: handle.redis)
    monkeypatch.setattr(auth_routes, "_enqueue_email", handle.enqueued.append)
    yield handle


@pytest.fixture()
async def app(
    session_factory: async_sessionmaker[AsyncSession], infra: Infra
) -> AsyncIterator[FastAPI]:
    application: FastAPI = create_app(database_ready_check=ready)

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    application.dependency_overrides[get_session] = override_get_session
    yield application
    application.dependency_overrides.clear()


@pytest.fixture()
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http_client:
        yield http_client


async def register(
    client: AsyncClient,
    *,
    username: str = "alice",
    email: str | None = None,
    password: str = "correct-password",
) -> dict[str, object]:
    email = email or f"{username}@{TEST_DOMAIN}"
    response = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "email": email, "password": password},
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return cast(dict[str, object], response.json()["data"])


def auth_header(data: dict[str, object]) -> dict[str, str]:
    return {"Authorization": f"Bearer {data['access_token']}"}


async def latest_verification_token(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> str:
    """Pull the raw token from the most recent outbox link for an email."""
    async with session_factory() as session:
        url = await session.scalar(
            select(EmailOutbox.payload["verification_url"].astext)
            .where(EmailOutbox.recipient_email == email)
            .order_by(EmailOutbox.id.desc())
            .limit(1)
        )
    assert url is not None
    return parse_qs(urlparse(url).query)["token"][0]


# --- /me ---


async def test_me_returns_current_user(client: AsyncClient) -> None:
    data = await register(client)
    response = await client.get("/api/v1/auth/me", headers=auth_header(data))

    assert response.status_code == status.HTTP_200_OK
    body = response.json()["data"]
    assert body["username"] == "alice"
    assert body["email_verified"] is False


async def test_me_requires_auth(client: AsyncClient) -> None:
    response = await client.get("/api/v1/auth/me")
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


# --- register side effects ---


async def test_register_creates_token_and_outbox_and_enqueues(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client)
    user_id = cast(dict[str, object], data["user"])["id"]

    async with session_factory() as session:
        tokens = (
            await session.execute(
                select(AuthToken).where(AuthToken.user_id == user_id)
            )
        ).scalars().all()
        outboxes = (
            await session.execute(
                select(EmailOutbox).where(
                    EmailOutbox.recipient_email == f"alice@{TEST_DOMAIN}"
                )
            )
        ).scalars().all()

    assert len(tokens) == 1
    assert len(outboxes) == 1
    assert infra.enqueued == [outboxes[0].id]


# --- verify-email ---


async def test_verify_email_happy_path(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)
    token = await latest_verification_token(session_factory, f"alice@{TEST_DOMAIN}")

    response = await client.post("/api/v1/auth/verify-email", json={"token": token})
    assert response.status_code == status.HTTP_200_OK

    me = await client.get("/api/v1/auth/me", headers=auth_header(data))
    assert me.json()["data"]["email_verified"] is True


async def test_verify_email_invalid_token_is_generic_400(client: AsyncClient) -> None:
    response = await client.post("/api/v1/auth/verify-email", json={"token": "bogus"})
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.json() == {"detail": "Invalid or expired verification link"}


async def test_verify_email_empty_token_is_422(client: AsyncClient) -> None:
    response = await client.post("/api/v1/auth/verify-email", json={"token": ""})
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


async def test_verify_email_reused_token_fails(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await register(client)
    token = await latest_verification_token(session_factory, f"alice@{TEST_DOMAIN}")

    first = await client.post("/api/v1/auth/verify-email", json={"token": token})
    second = await client.post("/api/v1/auth/verify-email", json={"token": token})

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_400_BAD_REQUEST


# --- resend-verification-email ---


async def test_resend_creates_new_outbox(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)

    response = await client.post(
        "/api/v1/auth/resend-verification-email", headers=auth_header(data)
    )
    assert response.status_code == status.HTTP_200_OK

    async with session_factory() as session:
        outboxes = (
            await session.execute(
                select(EmailOutbox).where(
                    EmailOutbox.recipient_email == f"alice@{TEST_DOMAIN}"
                )
            )
        ).scalars().all()
        active = (
            await session.execute(
                select(AuthToken).where(
                    AuthToken.user_id == cast(dict[str, object], data["user"])["id"],
                    AuthToken.used_at.is_(None),
                    AuthToken.revoked_at.is_(None),
                )
            )
        ).scalars().all()
    assert len(outboxes) == 2  # register + resend
    assert len(active) == 1  # old token revoked


async def test_resend_when_verified_is_ok_without_sending(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)
    token = await latest_verification_token(session_factory, f"alice@{TEST_DOMAIN}")
    await client.post("/api/v1/auth/verify-email", json={"token": token})

    response = await client.post(
        "/api/v1/auth/resend-verification-email", headers=auth_header(data)
    )
    assert response.status_code == status.HTTP_200_OK

    async with session_factory() as session:
        outboxes = (
            await session.execute(
                select(EmailOutbox).where(
                    EmailOutbox.recipient_email == f"alice@{TEST_DOMAIN}"
                )
            )
        ).scalars().all()
    assert len(outboxes) == 1  # no new email after verification


async def test_resend_cooldown_returns_429_with_retry_after(client: AsyncClient) -> None:
    data = await register(client)

    first = await client.post(
        "/api/v1/auth/resend-verification-email", headers=auth_header(data)
    )
    second = await client.post(
        "/api/v1/auth/resend-verification-email", headers=auth_header(data)
    )

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "retry-after" in {k.lower() for k in second.headers}


async def test_resend_requires_auth(client: AsyncClient) -> None:
    response = await client.post("/api/v1/auth/resend-verification-email")
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


# --- register IP rate limit ---


async def test_register_ip_rate_limit(client: AsyncClient, app: FastAPI) -> None:
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(
        update={"auth_rate_register_ip_limit": 1}
    )

    first = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "ip-a",
            "email": f"ip-a@{TEST_DOMAIN}",
            "password": "correct-password",
        },
    )
    second = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "ip-b",
            "email": f"ip-b@{TEST_DOMAIN}",
            "password": "correct-password",
        },
    )

    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS
