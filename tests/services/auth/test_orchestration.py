"""DB-backed tests for auth email use-case orchestration."""

import os
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fakeredis import aioredis
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth import orchestration, rate_limit

TEST_DATABASE_URL = os.environ.get(
    "AUTH_ORCHESTRATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "auth-orchestration-test.example.com"


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
def redis() -> aioredis.FakeRedis:
    return aioredis.FakeRedis(decode_responses=True)


def registration() -> dict[str, str]:
    suffix = uuid4().hex
    return {
        "username": f"orchestration-{suffix}",
        "nickname": f"Orchestration {suffix}",
        "email": f"orchestration-{suffix}@{TEST_DOMAIN}",
        "password": "correct-password",
    }


async def test_register_commits_user_and_outbox_before_dispatch(
    session_factory: async_sessionmaker[AsyncSession],
    redis: aioredis.FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    details = registration()
    dispatched: list[int] = []
    monkeypatch.setattr(orchestration.send_email_outbox, "delay", dispatched.append)

    async with session_factory() as session:
        response = await orchestration.register_with_verification(
            session,
            redis,
            client_ip="1.2.3.4",
            settings=get_settings(),
            **details,
        )

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == details["email"]))
        outbox = await session.scalar(
            select(EmailOutbox).where(EmailOutbox.recipient_email == details["email"])
        )

    assert user is not None
    assert response.user.id == user.id
    assert response.user.nickname == details["nickname"]
    assert user.nickname == details["nickname"]
    assert outbox is not None
    assert dispatched == [outbox.id]


async def test_register_rolls_back_and_releases_cooldown_when_commit_fails(
    session_factory: async_sessionmaker[AsyncSession],
    redis: aioredis.FakeRedis,
) -> None:
    details = registration()
    cooldown_key = rate_limit.cooldown_email_key("email_verification", details["email"])

    async with session_factory() as session:
        session.commit = AsyncMock(side_effect=RuntimeError("commit failed"))  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="commit failed"):
            await orchestration.register_with_verification(
                session,
                redis,
                client_ip="1.2.3.4",
                settings=get_settings(),
                **details,
            )

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == details["email"]))

    assert user is None
    assert await redis.exists(cooldown_key) == 0


async def test_dispatch_failure_does_not_fail_committed_registration(
    session_factory: async_sessionmaker[AsyncSession],
    redis: aioredis.FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    details = registration()

    def fail_dispatch(outbox_id: int) -> None:
        raise ConnectionError(f"broker unavailable for {outbox_id}")

    monkeypatch.setattr(orchestration.send_email_outbox, "delay", fail_dispatch)

    async with session_factory() as session:
        response = await orchestration.register_with_verification(
            session,
            redis,
            client_ip="1.2.3.4",
            settings=get_settings(),
            **details,
        )

    async with session_factory() as session:
        user = await session.get(User, response.user.id)
        outbox = await session.scalar(
            select(EmailOutbox).where(EmailOutbox.recipient_email == details["email"])
        )

    assert user is not None
    assert outbox is not None
    assert outbox.status == "pending"


async def test_resend_rolls_back_and_releases_all_cooldowns_when_commit_fails(
    session_factory: async_sessionmaker[AsyncSession],
    redis: aioredis.FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    details = registration()
    monkeypatch.setattr(orchestration.send_email_outbox, "delay", lambda _: None)

    async with session_factory() as session:
        response = await orchestration.register_with_verification(
            session,
            redis,
            client_ip="1.2.3.4",
            settings=get_settings(),
            **details,
        )

    email_key = rate_limit.cooldown_email_key("email_verification", details["email"])
    await redis.delete(email_key)

    async with session_factory() as session:
        user = await session.get(User, response.user.id)
        assert user is not None
        user_key = rate_limit.cooldown_user_key("email_verification", user.id)
        session.commit = AsyncMock(side_effect=RuntimeError("commit failed"))  # type: ignore[method-assign]

        with pytest.raises(RuntimeError, match="commit failed"):
            await orchestration.resend_verification_email(
                session,
                redis,
                user=user,
                client_ip="1.2.3.4",
                settings=get_settings(),
            )

    assert await redis.exists(user_key) == 0
    assert await redis.exists(email_key) == 0


async def test_resend_rechecks_verified_user_before_consuming_redis_quota(
    session_factory: async_sessionmaker[AsyncSession],
    redis: aioredis.FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    details = registration()
    monkeypatch.setattr(orchestration.send_email_outbox, "delay", lambda _: None)

    async with session_factory() as session:
        response = await orchestration.register_with_verification(
            session,
            redis,
            client_ip="1.2.3.4",
            settings=get_settings(),
            **details,
        )

    email_key = rate_limit.cooldown_email_key("email_verification", details["email"])
    await redis.delete(email_key)

    async with session_factory() as stale_session:
        stale_user = await stale_session.get(User, response.user.id)
        assert stale_user is not None and stale_user.email_verified is False

        async with session_factory() as verifying_session:
            verified_user = await verifying_session.get(User, response.user.id)
            assert verified_user is not None
            verified_user.email_verified = True
            await verifying_session.commit()

        await orchestration.resend_verification_email(
            stale_session,
            redis,
            user=stale_user,
            client_ip="5.6.7.8",
            settings=get_settings(),
        )

    user_key = rate_limit.cooldown_user_key("email_verification", response.user.id)
    ip_key = rate_limit.ip_rate_key("resend_verification", "5.6.7.8")
    assert await redis.exists(user_key) == 0
    assert await redis.exists(email_key) == 0
    assert await redis.exists(ip_key) == 0
