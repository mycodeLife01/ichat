"""DB-backed tests for verification orchestration and rate-limit guards.

Requires PostgreSQL. Uses fakeredis for the happy paths and a stub that raises
for the Redis-outage policies (register degrade, resend fail-closed, verify
fail-open).
"""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fakeredis import aioredis
from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.errors import AppError
from app.models.auth_token import AuthToken
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth import verification
from app.services.auth.token_service import issue_email_verification_token

TEST_DATABASE_URL = os.environ.get(
    "VERIFICATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "verification-test.example.com"


class _BrokenRedis:
    """Stand-in for an unreachable Redis: every op raises."""

    async def eval(self, *args: object, **kwargs: object) -> object:
        raise ConnectionError("redis down")

    async def set(self, *args: object, **kwargs: object) -> object:
        raise ConnectionError("redis down")

    async def delete(self, *args: object, **kwargs: object) -> object:
        raise ConnectionError("redis down")


async def _clean(session: AsyncSession) -> None:
    await session.execute(delete(User).where(User.email.like(f"%@{TEST_DOMAIN}")))
    await session.execute(
        delete(EmailOutbox).where(EmailOutbox.recipient_email.like(f"%@{TEST_DOMAIN}"))
    )


@pytest.fixture()
async def session() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as setup:
        await _clean(setup)
        await setup.commit()
    async with factory() as active:
        yield active
    async with factory() as teardown:
        await _clean(teardown)
        await teardown.commit()
    await engine.dispose()


@pytest.fixture
def redis() -> aioredis.FakeRedis:
    return aioredis.FakeRedis(decode_responses=True)


def _settings(**overrides: object) -> object:
    return get_settings().model_copy(update=overrides)


async def make_user(session: AsyncSession, *, email_verified: bool = False) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"vrf-{suffix}",
        email=f"vrf-{suffix}@{TEST_DOMAIN}",
        password_hash="hash",
        email_verified=email_verified,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def _outbox_count(session: AsyncSession, user: User) -> int:
    rows = (
        await session.execute(
            select(EmailOutbox.id).where(EmailOutbox.recipient_email == user.email)
        )
    ).scalars().all()
    return len(rows)


# --- create_verification_email / resend ---


async def test_create_verification_email_issues_token_and_outbox(
    session: AsyncSession,
) -> None:
    user = await make_user(session)

    outbox_id = await verification.create_verification_email(
        session, user=user, settings=get_settings()
    )

    outbox = await session.get(EmailOutbox, outbox_id)
    assert outbox is not None
    assert outbox.recipient_email == user.email
    assert outbox.status == "pending"
    assert "/verify-email?token=" in outbox.payload["verification_url"]
    active = (
        await session.execute(
            select(AuthToken).where(
                AuthToken.user_id == user.id,
                AuthToken.used_at.is_(None),
                AuthToken.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    assert len(active) == 1


async def test_resend_revokes_old_token_and_creates_new_outbox(
    session: AsyncSession,
) -> None:
    user = await make_user(session)
    await verification.create_verification_email(session, user=user, settings=get_settings())

    await verification.create_verification_email_for_user(
        session, user_id=user.id, settings=get_settings()
    )

    active = (
        await session.execute(
            select(AuthToken).where(
                AuthToken.user_id == user.id,
                AuthToken.used_at.is_(None),
                AuthToken.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    assert len(active) == 1
    assert await _outbox_count(session, user) == 2


async def test_create_for_user_skips_already_verified(session: AsyncSession) -> None:
    user = await make_user(session, email_verified=True)

    result = await verification.create_verification_email_for_user(
        session, user_id=user.id, settings=get_settings()
    )

    assert result is None
    assert await _outbox_count(session, user) == 0


# --- verify_email ---


async def test_verify_email_happy_path(session: AsyncSession) -> None:
    user = await make_user(session)
    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)

    await verification.verify_email(session, raw_token=raw)

    assert user.email_verified is True
    token = await session.scalar(select(AuthToken).where(AuthToken.user_id == user.id))
    assert token is not None and token.used_at is not None


async def test_verify_email_invalid_token_raises(session: AsyncSession) -> None:
    with pytest.raises(AppError) as exc:
        await verification.verify_email(session, raw_token="not-a-real-token")
    assert exc.value.status_code == status.HTTP_400_BAD_REQUEST


async def test_verify_email_idempotent_when_already_verified(session: AsyncSession) -> None:
    user = await make_user(session, email_verified=True)
    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)

    await verification.verify_email(session, raw_token=raw)  # no raise

    assert user.email_verified is True


async def test_expired_token_does_not_reset_verified_user(session: AsyncSession) -> None:
    user = await make_user(session, email_verified=True)
    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)
    token = await session.scalar(select(AuthToken).where(AuthToken.user_id == user.id))
    assert token is not None
    token.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await session.flush()

    with pytest.raises(AppError):
        await verification.verify_email(session, raw_token=raw)
    assert user.email_verified is True


# --- guards ---


async def test_register_email_cooldown_blocks_repeat(
    session: AsyncSession, redis: aioredis.FakeRedis
) -> None:
    email = f"guard-{uuid4().hex}@{TEST_DOMAIN}"
    key = await verification.acquire_register_email_cooldown(
        session, redis, email=email, settings=get_settings()
    )
    assert key is not None
    with pytest.raises(AppError) as exc:
        await verification.acquire_register_email_cooldown(
            session, redis, email=email, settings=get_settings()
        )
    assert exc.value.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert "Retry-After" in (exc.value.headers or {})


async def test_register_ip_guard_limit(redis: aioredis.FakeRedis) -> None:
    settings = _settings(auth_rate_register_ip_limit=1)
    await verification.register_ip_guard(redis, client_ip="9.9.9.9", settings=settings)
    with pytest.raises(AppError) as exc:
        await verification.register_ip_guard(redis, client_ip="9.9.9.9", settings=settings)
    assert exc.value.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_register_cooldown_degrades_when_redis_down(session: AsyncSession) -> None:
    user = await make_user(session)
    # A recent token exists for this email -> DB cooldown should block.
    await issue_email_verification_token(session, user=user, ttl_seconds=86400)

    with pytest.raises(AppError) as exc:
        await verification.acquire_register_email_cooldown(
            session, _BrokenRedis(), email=user.email, settings=get_settings()
        )
    assert exc.value.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_register_cooldown_degrades_open_without_recent_token(
    session: AsyncSession,
) -> None:
    key = await verification.acquire_register_email_cooldown(
        session,
        _BrokenRedis(),
        email=f"fresh-{uuid4().hex}@{TEST_DOMAIN}",
        settings=get_settings(),
    )
    assert key is None  # degraded, no cooldown key to release


async def test_register_ip_guard_fails_open_when_redis_down() -> None:
    # IP flood guard must never hard-fail registration on a Redis outage.
    await verification.register_ip_guard(
        _BrokenRedis(), client_ip="1.2.3.4", settings=get_settings()
    )


async def test_resend_guard_fails_closed_when_redis_down(session: AsyncSession) -> None:
    user = await make_user(session)
    with pytest.raises(AppError) as exc:
        await verification.resend_guard(
            _BrokenRedis(), user=user, client_ip="1.2.3.4", settings=get_settings()
        )
    assert exc.value.status_code == status.HTTP_429_TOO_MANY_REQUESTS


async def test_verify_guard_fails_open_when_redis_down() -> None:
    # Should not raise.
    await verification.verify_ip_guard(
        _BrokenRedis(), client_ip="1.2.3.4", settings=get_settings()
    )
