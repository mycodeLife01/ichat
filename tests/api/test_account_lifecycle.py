"""API tests for password reset / change / account deletion endpoints.

Same seam as tests/api/test_email_verification.py: ASGI client against real
PostgreSQL, Redis replaced with fakeredis, Celery enqueue captured.
"""

import os
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import cast
from urllib.parse import parse_qs, urlparse

import pytest
from fakeredis import aioredis
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.auth_token import AuthToken
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth import orchestration, rate_limit
from app.services.auth.token_service import PURPOSE_PASSWORD_RESET

TEST_DATABASE_URL = os.environ.get(
    "ACCOUNT_LIFECYCLE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "account-lifecycle-api-test.example.com"
PASSWORD = "correct-password"


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
    monkeypatch.setattr(orchestration.send_email_outbox, "delay", handle.enqueued.append)
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
    application.dependency_overrides[rate_limit.get_redis] = lambda: infra.redis
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
    password: str = PASSWORD,
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


def user_id_of(data: dict[str, object]) -> int:
    return cast(int, cast(dict[str, object], data["user"])["id"])


async def request_reset(client: AsyncClient, email: str) -> Response:
    return await client.post(
        "/api/v1/auth/request-password-reset", json={"email": email}
    )


async def clear_email_cooldown(infra: Infra, purpose: str, email: str) -> None:
    """Model Redis TTL expiry without sleeping in the test."""
    await infra.redis.delete(rate_limit.cooldown_email_key(purpose, email))


async def outbox_rows(
    session_factory: async_sessionmaker[AsyncSession], email: str, kind: str
) -> list[EmailOutbox]:
    async with session_factory() as session:
        return list(
            (
                await session.execute(
                    select(EmailOutbox).where(
                        EmailOutbox.recipient_email == email, EmailOutbox.kind == kind
                    )
                )
            ).scalars().all()
        )


async def tokens_of(
    session_factory: async_sessionmaker[AsyncSession], user_id: int, purpose: str
) -> list[AuthToken]:
    async with session_factory() as session:
        return list(
            (
                await session.execute(
                    select(AuthToken).where(
                        AuthToken.user_id == user_id, AuthToken.purpose == purpose
                    )
                )
            ).scalars().all()
        )


def link_token(outbox: EmailOutbox, payload_key: str) -> str:
    url = cast(str, outbox.payload[payload_key])
    return parse_qs(urlparse(url).query)["token"][0]


class BrokenRedis:
    """Stand-in for a Redis outage: every command raises."""

    def __getattr__(self, name: str) -> object:
        async def _fail(*args: object, **kwargs: object) -> object:
            raise ConnectionError("redis down")

        return _fail


async def deactivate_user(
    session_factory: async_sessionmaker[AsyncSession], user_id: int
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(User).where(User.id == user_id).values(is_active=False)
        )
        await session.commit()


# --- request-password-reset ---


async def test_request_reset_issues_token_and_sends_email(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"

    response = await request_reset(client, email)

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {"status": "ok"}

    tokens = await tokens_of(session_factory, user_id_of(data), PURPOSE_PASSWORD_RESET)
    assert len(tokens) == 1
    rows = await outbox_rows(session_factory, email, PURPOSE_PASSWORD_RESET)
    assert len(rows) == 1
    assert "/reset-password?token=" in cast(str, rows[0].payload["reset_url"])
    assert rows[0].id in infra.enqueued


async def test_request_reset_unknown_email_responds_identically_without_sending(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    email = f"ghost@{TEST_DOMAIN}"

    response = await request_reset(client, email)

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {"status": "ok"}
    assert await outbox_rows(session_factory, email, PURPOSE_PASSWORD_RESET) == []
    assert infra.enqueued == []


async def test_request_reset_deactivated_account_responds_identically_without_sending(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client)
    await deactivate_user(session_factory, user_id_of(data))
    infra.enqueued.clear()
    email = f"alice@{TEST_DOMAIN}"

    response = await request_reset(client, email)

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {"status": "ok"}
    assert await tokens_of(session_factory, user_id_of(data), PURPOSE_PASSWORD_RESET) == []
    assert await outbox_rows(session_factory, email, PURPOSE_PASSWORD_RESET) == []
    assert infra.enqueued == []


async def test_request_reset_unverified_user_still_gets_email(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Registration leaves email_verified=False; the reset channel must not
    # depend on prior verification (only self-rescue path for those users).
    await register(client)
    email = f"alice@{TEST_DOMAIN}"

    response = await request_reset(client, email)

    assert response.status_code == status.HTTP_200_OK
    assert len(await outbox_rows(session_factory, email, PURPOSE_PASSWORD_RESET)) == 1


@pytest.mark.parametrize("registered", [True, False])
async def test_request_reset_cooldown_429_is_identical_for_unknown_email(
    client: AsyncClient,
    registered: bool,
) -> None:
    if registered:
        await register(client)
    email = f"alice@{TEST_DOMAIN}"

    first = await request_reset(client, email)
    second = await request_reset(client, email)

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "retry-after" in {k.lower() for k in second.headers}


async def test_request_reset_ip_rate_limit(client: AsyncClient, app: FastAPI) -> None:
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(
        update={"auth_rate_password_reset_request_ip_limit": 1}
    )

    first = await request_reset(client, f"one@{TEST_DOMAIN}")
    second = await request_reset(client, f"two@{TEST_DOMAIN}")

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_request_reset_stays_available_when_redis_down(
    client: AsyncClient,
    app: FastAPI,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register(client)
    app.dependency_overrides[rate_limit.get_redis] = lambda: BrokenRedis()
    email = f"alice@{TEST_DOMAIN}"

    first = await request_reset(client, email)
    second = await request_reset(client, email)

    # Degraded but available: the email is sent, and the immediate repeat is
    # blocked by the DB cooldown fallback.
    assert first.status_code == status.HTTP_200_OK
    assert len(await outbox_rows(session_factory, email, PURPOSE_PASSWORD_RESET)) == 1
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS
