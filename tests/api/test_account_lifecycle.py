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
from app.services.auth.token_service import (
    PURPOSE_ACCOUNT_DELETION,
    PURPOSE_PASSWORD_RESET,
    issue_auth_token,
)

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

# --- reset-password ---


async def latest_reset_token(
    session_factory: async_sessionmaker[AsyncSession], email: str
) -> str:
    rows = await outbox_rows(session_factory, email, PURPOSE_PASSWORD_RESET)
    assert rows
    return link_token(rows[-1], "reset_url")


async def login(client: AsyncClient, identifier: str, password: str) -> Response:
    return await client.post(
        "/api/v1/auth/login", json={"identifier": identifier, "password": password}
    )


async def reset_password(client: AsyncClient, token: str, new_password: str) -> Response:
    return await client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": new_password},
    )


async def test_reset_password_end_to_end(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)
    token = await latest_reset_token(session_factory, email)

    response = await reset_password(client, token, "brand-new-password")

    assert response.status_code == status.HTTP_200_OK
    # Command response only — no auto-login credentials.
    assert response.json()["data"] == {"status": "ok"}

    assert (await login(client, email, "brand-new-password")).status_code == status.HTTP_200_OK
    assert (await login(client, email, PASSWORD)).status_code == status.HTTP_401_UNAUTHORIZED

    # All pre-reset sessions are forced out.
    refresh = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": data["refresh_token"]}
    )
    assert refresh.status_code == status.HTTP_401_UNAUTHORIZED


async def test_reset_password_marks_email_verified_and_revokes_pending_tokens(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)
    token = await latest_reset_token(session_factory, email)
    # Pending sensitive token of the other purpose must be revoked too.
    async with session_factory() as session:
        user = await session.get(User, user_id_of(data))
        assert user is not None
        await issue_auth_token(
            session, user=user, purpose=PURPOSE_ACCOUNT_DELETION, ttl_seconds=1800
        )
        await session.commit()

    response = await reset_password(client, token, "brand-new-password")
    assert response.status_code == status.HTTP_200_OK

    logged_in = await login(client, email, "brand-new-password")
    me = await client.get(
        "/api/v1/auth/me", headers=auth_header(logged_in.json()["data"])
    )
    assert me.json()["data"]["email_verified"] is True

    deletion_tokens = await tokens_of(
        session_factory, user_id_of(data), PURPOSE_ACCOUNT_DELETION
    )
    assert all(t.revoked_at is not None for t in deletion_tokens)


async def test_reset_password_rejects_reused_token(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)
    token = await latest_reset_token(session_factory, email)

    first = await reset_password(client, token, "brand-new-password")
    second = await reset_password(client, token, "another-password-1")

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_400_BAD_REQUEST
    assert second.json() == {"detail": "Invalid or expired reset link"}
    # The failed second attempt must not have changed the password.
    assert (await login(client, email, "brand-new-password")).status_code == status.HTTP_200_OK


async def test_reset_password_rejects_expired_token(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)
    token = await latest_reset_token(session_factory, email)
    async with session_factory() as session:
        from datetime import UTC, datetime, timedelta

        await session.execute(
            update(AuthToken)
            .where(AuthToken.purpose == PURPOSE_PASSWORD_RESET)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.commit()

    response = await reset_password(client, token, "brand-new-password")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert (await login(client, email, PASSWORD)).status_code == status.HTTP_200_OK


async def test_reset_password_rejects_token_revoked_by_newer_request(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession], infra: Infra
) -> None:
    await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)
    old_token = await latest_reset_token(session_factory, email)
    await clear_email_cooldown(infra, PURPOSE_PASSWORD_RESET, email)
    await request_reset(client, email)

    response = await reset_password(client, old_token, "brand-new-password")

    assert response.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize(
    "body",
    [
        {"token": "a" * 43},  # valid format, unknown token -> 400 handled elsewhere
    ],
)
async def test_reset_password_unknown_token_is_generic_400(
    client: AsyncClient, body: dict[str, str]
) -> None:
    response = await client.post(
        "/api/v1/auth/reset-password",
        json={**body, "new_password": "brand-new-password"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"token": "a" * 42, "new_password": "brand-new-password"},
        {"token": "a" * 42 + "!", "new_password": "brand-new-password"},
        {"token": "a" * 43, "new_password": "short"},
        {"token": "a" * 43, "new_password": "x" * 129},
        {"token": "a" * 43},
    ],
)
async def test_reset_password_invalid_format_is_422(
    client: AsyncClient, body: dict[str, str]
) -> None:
    response = await client.post("/api/v1/auth/reset-password", json=body)
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


async def test_reset_password_ip_rate_limit(client: AsyncClient, app: FastAPI) -> None:
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(
        update={"auth_rate_verify_ip_limit": 1}
    )

    first = await client.post(
        "/api/v1/auth/reset-password",
        json={"token": "a" * 43, "new_password": "brand-new-password"},
    )
    second = await client.post(
        "/api/v1/auth/reset-password",
        json={"token": "b" * 43, "new_password": "brand-new-password"},
    )

    assert first.status_code == status.HTTP_400_BAD_REQUEST
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_reset_password_fails_open_when_redis_down(
    client: AsyncClient, app: FastAPI, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)
    token = await latest_reset_token(session_factory, email)
    app.dependency_overrides[rate_limit.get_redis] = lambda: BrokenRedis()

    response = await reset_password(client, token, "brand-new-password")

    assert response.status_code == status.HTTP_200_OK
    assert (await login(client, email, "brand-new-password")).status_code == status.HTTP_200_OK

# --- change-password ---


async def change_password(
    client: AsyncClient,
    data: dict[str, object],
    current_password: str,
    new_password: str,
) -> Response:
    return await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": current_password, "new_password": new_password},
        headers=auth_header(data),
    )


async def test_change_password_end_to_end(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"

    response = await change_password(client, data, PASSWORD, "brand-new-password")

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {"status": "ok"}

    assert (await login(client, email, "brand-new-password")).status_code == status.HTTP_200_OK
    assert (await login(client, email, PASSWORD)).status_code == status.HTTP_401_UNAUTHORIZED

    # Every session is kicked, including the one that made the change.
    refresh = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": data["refresh_token"]}
    )
    assert refresh.status_code == status.HTTP_401_UNAUTHORIZED


async def test_change_password_revokes_pending_sensitive_tokens(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_reset(client, email)

    response = await change_password(client, data, PASSWORD, "brand-new-password")
    assert response.status_code == status.HTTP_200_OK

    reset_tokens = await tokens_of(session_factory, user_id_of(data), PURPOSE_PASSWORD_RESET)
    assert reset_tokens and all(t.revoked_at is not None for t in reset_tokens)


async def test_change_password_wrong_current_password_changes_nothing(
    client: AsyncClient,
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"

    response = await change_password(client, data, "not-the-password", "brand-new-password")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert response.json() == {"detail": "Current password is incorrect"}
    assert (await login(client, email, PASSWORD)).status_code == status.HTTP_200_OK


async def test_change_password_locks_out_after_repeated_failures(
    client: AsyncClient, app: FastAPI
) -> None:
    data = await register(client)
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(
        update={"auth_rate_password_change_user_limit": 2}
    )

    first = await change_password(client, data, "not-the-password", "brand-new-password")
    second = await change_password(client, data, "not-the-password", "brand-new-password")
    # Budget exhausted: even the correct password is now rejected with 429.
    third = await change_password(client, data, PASSWORD, "brand-new-password")

    assert first.status_code == status.HTTP_400_BAD_REQUEST
    assert second.status_code == status.HTTP_400_BAD_REQUEST
    assert third.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "retry-after" in {k.lower() for k in third.headers}


async def test_change_password_ip_rate_limit(client: AsyncClient, app: FastAPI) -> None:
    data = await register(client)
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(
        update={"auth_rate_password_change_ip_limit": 1}
    )

    first = await change_password(client, data, PASSWORD, "brand-new-password")
    second = await change_password(client, data, "brand-new-password", "third-password-1")

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_change_password_fails_closed_when_redis_down(
    client: AsyncClient, app: FastAPI
) -> None:
    data = await register(client)
    app.dependency_overrides[rate_limit.get_redis] = lambda: BrokenRedis()

    response = await change_password(client, data, PASSWORD, "brand-new-password")

    assert response.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "retry-after" in {k.lower() for k in response.headers}
    # Fail-closed means no change happened.
    assert (
        await login(client, f"alice@{TEST_DOMAIN}", PASSWORD)
    ).status_code == status.HTTP_200_OK


async def test_change_password_requires_auth(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "brand-new-password"},
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"current_password": PASSWORD},
        {"current_password": PASSWORD, "new_password": "short"},
        {"current_password": PASSWORD, "new_password": "x" * 129},
        {"current_password": "short", "new_password": "brand-new-password"},
    ],
)
async def test_change_password_invalid_format_is_422(
    client: AsyncClient, body: dict[str, str]
) -> None:
    data = await register(client)
    response = await client.post(
        "/api/v1/auth/change-password", json=body, headers=auth_header(data)
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY

# --- request-account-deletion ---


async def request_deletion(
    client: AsyncClient, data: dict[str, object], password: str
) -> Response:
    return await client.post(
        "/api/v1/auth/request-account-deletion",
        json={"password": password},
        headers=auth_header(data),
    )


async def test_request_deletion_issues_token_and_sends_confirmation_email(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"

    response = await request_deletion(client, data, PASSWORD)

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {"status": "ok"}

    tokens = await tokens_of(session_factory, user_id_of(data), PURPOSE_ACCOUNT_DELETION)
    assert len(tokens) == 1
    rows = await outbox_rows(session_factory, email, PURPOSE_ACCOUNT_DELETION)
    assert len(rows) == 1
    assert "/confirm-account-deletion?token=" in cast(str, rows[0].payload["deletion_url"])
    assert rows[0].id in infra.enqueued


async def test_request_deletion_wrong_password_sends_nothing(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client)
    infra.enqueued.clear()

    response = await request_deletion(client, data, "not-the-password")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert await tokens_of(session_factory, user_id_of(data), PURPOSE_ACCOUNT_DELETION) == []
    assert await outbox_rows(
        session_factory, f"alice@{TEST_DOMAIN}", PURPOSE_ACCOUNT_DELETION
    ) == []
    assert infra.enqueued == []


async def test_request_deletion_cooldown_returns_429(
    client: AsyncClient,
) -> None:
    data = await register(client)

    first = await request_deletion(client, data, PASSWORD)
    second = await request_deletion(client, data, PASSWORD)

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "retry-after" in {k.lower() for k in second.headers}


async def test_request_deletion_after_cooldown_rotates_token(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    infra: Infra,
) -> None:
    data = await register(client)
    email = f"alice@{TEST_DOMAIN}"
    await request_deletion(client, data, PASSWORD)
    await clear_email_cooldown(infra, PURPOSE_ACCOUNT_DELETION, email)
    await infra.redis.delete(
        rate_limit.cooldown_user_key(PURPOSE_ACCOUNT_DELETION, user_id_of(data))
    )

    response = await request_deletion(client, data, PASSWORD)

    assert response.status_code == status.HTTP_200_OK
    tokens = await tokens_of(session_factory, user_id_of(data), PURPOSE_ACCOUNT_DELETION)
    active = [t for t in tokens if t.used_at is None and t.revoked_at is None]
    assert len(tokens) == 2
    assert len(active) == 1


async def test_request_deletion_ip_rate_limit(client: AsyncClient, app: FastAPI) -> None:
    data = await register(client)
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(
        update={"auth_rate_deletion_request_ip_limit": 1}
    )

    first = await request_deletion(client, data, "not-the-password")
    second = await request_deletion(client, data, "not-the-password")

    # The IP window counts attempts before the password check (throttles guessing).
    assert first.status_code == status.HTTP_400_BAD_REQUEST
    assert second.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_request_deletion_fails_closed_when_redis_down(
    client: AsyncClient,
    app: FastAPI,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    data = await register(client)
    app.dependency_overrides[rate_limit.get_redis] = lambda: BrokenRedis()

    response = await request_deletion(client, data, PASSWORD)

    assert response.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "retry-after" in {k.lower() for k in response.headers}
    assert await tokens_of(session_factory, user_id_of(data), PURPOSE_ACCOUNT_DELETION) == []


async def test_request_deletion_requires_auth(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/auth/request-account-deletion", json={"password": PASSWORD}
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


@pytest.mark.parametrize("body", [{}, {"password": "short"}, {"password": "x" * 129}])
async def test_request_deletion_invalid_format_is_422(
    client: AsyncClient, body: dict[str, str]
) -> None:
    data = await register(client)
    response = await client.post(
        "/api/v1/auth/request-account-deletion", json=body, headers=auth_header(data)
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
