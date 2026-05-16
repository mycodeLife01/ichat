import os
from collections.abc import AsyncIterator
from typing import cast

import pytest
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.session import get_session
from app.main import create_app
from app.models.user import RefreshToken, User

TEST_DATABASE_URL = os.environ.get(
    "AUTH_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "auth-test.example.com"


async def ready() -> bool:
    return True


@pytest.fixture()
async def auth_session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with session_factory() as session:
        await session.execute(delete(User).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")))
        await session.commit()

    yield session_factory

    async with session_factory() as session:
        await session.execute(delete(User).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")))
        await session.commit()
    await engine.dispose()


@pytest.fixture()
async def auth_app(
    auth_session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[FastAPI]:
    app = create_app(database_ready_check=ready)

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with auth_session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    yield app
    app.dependency_overrides.clear()


@pytest.fixture()
async def auth_client(auth_app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=auth_app),
        base_url="http://test",
    ) as client:
        yield client


async def register_user(
    client: AsyncClient,
    *,
    username: str = "alice",
    email: str = f"alice@{TEST_EMAIL_DOMAIN}",
    password: str = "correct-password",
) -> dict[str, object]:
    response = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "email": email, "password": password},
    )
    assert response.status_code == status.HTTP_201_CREATED
    return cast(dict[str, object], response.json()["data"])


async def test_register_returns_enveloped_tokens_and_persists_user(
    auth_client: AsyncClient,
    auth_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    data = await register_user(auth_client)

    assert set(data) == {"user", "access_token", "refresh_token", "token_type", "expires_in"}
    assert data["token_type"] == "bearer"
    assert data["expires_in"] == 900
    assert isinstance(data["access_token"], str)
    assert isinstance(data["refresh_token"], str)
    assert data["access_token"] != data["refresh_token"]
    user_data = data["user"]
    assert isinstance(user_data, dict)
    assert isinstance(user_data["id"], int)
    assert user_data["username"] == "alice"
    assert user_data["email"] == f"alice@{TEST_EMAIL_DOMAIN}"
    assert user_data["email_verified"] is False

    async with auth_session_factory() as session:
        user = await session.scalar(select(User).where(User.username == "alice"))
        assert user is not None
        assert user.email == f"alice@{TEST_EMAIL_DOMAIN}"
        assert user.password_hash != "correct-password"
        assert user.email_verified is False
        token = await session.scalar(select(RefreshToken).where(RefreshToken.user_id == user.id))
        assert token is not None
        assert token.token_hash != data["refresh_token"]
        assert token.revoked_at is None


async def test_register_rejects_duplicate_username_case_insensitively(
    auth_client: AsyncClient,
) -> None:
    await register_user(auth_client, username="alice", email=f"alice@{TEST_EMAIL_DOMAIN}")

    response = await auth_client.post(
        "/api/v1/auth/register",
        json={
            "username": "ALICE",
            "email": f"alice2@{TEST_EMAIL_DOMAIN}",
            "password": "correct-password",
        },
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Username is already registered"}


async def test_register_rejects_duplicate_email_case_insensitively(
    auth_client: AsyncClient,
) -> None:
    await register_user(auth_client, username="alice", email=f"alice@{TEST_EMAIL_DOMAIN}")

    response = await auth_client.post(
        "/api/v1/auth/register",
        json={
            "username": "alice2",
            "email": f"ALICE@{TEST_EMAIL_DOMAIN}",
            "password": "correct-password",
        },
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Email is already registered"}


async def test_login_accepts_username_and_email(
    auth_client: AsyncClient,
) -> None:
    await register_user(auth_client, username="alice", email=f"alice@{TEST_EMAIL_DOMAIN}")

    username_response = await auth_client.post(
        "/api/v1/auth/login",
        json={"identifier": "alice", "password": "correct-password"},
    )
    email_response = await auth_client.post(
        "/api/v1/auth/login",
        json={"identifier": f"ALICE@{TEST_EMAIL_DOMAIN}", "password": "correct-password"},
    )

    assert username_response.status_code == status.HTTP_200_OK
    assert email_response.status_code == status.HTTP_200_OK
    assert username_response.json()["data"]["user"]["username"] == "alice"
    assert email_response.json()["data"]["user"]["email"] == f"alice@{TEST_EMAIL_DOMAIN}"


async def test_login_rejects_wrong_password(
    auth_client: AsyncClient,
) -> None:
    await register_user(auth_client)

    response = await auth_client.post(
        "/api/v1/auth/login",
        json={"identifier": "alice", "password": "wrong-password"},
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json() == {"detail": "Invalid username, email, or password"}


async def test_refresh_rotates_refresh_token_and_rejects_old_token(
    auth_client: AsyncClient,
) -> None:
    registered = await register_user(auth_client)
    old_refresh_token = registered["refresh_token"]

    refresh_response = await auth_client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": old_refresh_token},
    )
    old_refresh_response = await auth_client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": old_refresh_token},
    )

    assert refresh_response.status_code == status.HTTP_200_OK
    data = refresh_response.json()["data"]
    assert data["refresh_token"] != old_refresh_token
    assert data["access_token"] != registered["access_token"]
    assert old_refresh_response.status_code == status.HTTP_401_UNAUTHORIZED
    assert old_refresh_response.json() == {"detail": "Invalid refresh token"}


async def test_logout_revokes_refresh_token_idempotently(
    auth_client: AsyncClient,
) -> None:
    registered = await register_user(auth_client)
    refresh_token = registered["refresh_token"]

    logout_response = await auth_client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": refresh_token},
    )
    second_logout_response = await auth_client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": refresh_token},
    )
    refresh_response = await auth_client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": refresh_token},
    )

    assert logout_response.status_code == status.HTTP_200_OK
    assert logout_response.json() == {"data": {"status": "ok"}}
    assert second_logout_response.status_code == status.HTTP_200_OK
    assert second_logout_response.json() == {"data": {"status": "ok"}}
    assert refresh_response.status_code == status.HTTP_401_UNAUTHORIZED
    assert refresh_response.json() == {"detail": "Invalid refresh token"}
