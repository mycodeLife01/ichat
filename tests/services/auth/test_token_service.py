"""DB-backed tests for auth_tokens issuance/consumption.

Async psycopg-free (asyncpg) sessions against the dev database, same convention
as tests/services/runs/test_lifecycle.py. Requires PostgreSQL.
"""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.auth_token import AuthToken
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth.token_service import (
    PURPOSE_EMAIL_VERIFICATION,
    consume_email_verification_token,
    hash_auth_token,
    issue_email_verification_token,
    latest_token_created_at,
    revoke_active_tokens,
)

TEST_DATABASE_URL = os.environ.get(
    "AUTH_TOKEN_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "auth-token-test.example.com"


async def _clean(session: AsyncSession) -> None:
    # Deleting users cascades to auth_tokens (FK ondelete CASCADE).
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


async def make_user(session: AsyncSession) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"tok-{suffix}",
        email=f"tok-{suffix}@{TEST_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def test_issue_stores_only_hash(session: AsyncSession) -> None:
    user = await make_user(session)

    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)

    token = await session.scalar(select(AuthToken).where(AuthToken.user_id == user.id))
    assert token is not None
    assert token.token_hash == hash_auth_token(raw)
    assert token.token_hash != raw
    assert len(token.token_hash) == 64
    assert token.sent_to_email == user.email
    assert token.used_at is None and token.revoked_at is None


async def test_issue_revokes_previous_active_token(session: AsyncSession) -> None:
    user = await make_user(session)

    await issue_email_verification_token(session, user=user, ttl_seconds=86400)
    await issue_email_verification_token(session, user=user, ttl_seconds=86400)

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


async def test_consume_marks_used_and_returns_user(session: AsyncSession) -> None:
    user = await make_user(session)
    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)

    consumed = await consume_email_verification_token(session, raw_token=raw)

    assert consumed == (user.id, user.email)
    # Second consume of the same token fails (used).
    assert await consume_email_verification_token(session, raw_token=raw) is None


async def test_consume_rejects_expired_token(session: AsyncSession) -> None:
    user = await make_user(session)
    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)
    token = await session.scalar(select(AuthToken).where(AuthToken.user_id == user.id))
    assert token is not None
    token.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await session.flush()

    assert await consume_email_verification_token(session, raw_token=raw) is None


async def test_consume_rejects_revoked_token(session: AsyncSession) -> None:
    user = await make_user(session)
    raw = await issue_email_verification_token(session, user=user, ttl_seconds=86400)
    await revoke_active_tokens(
        session, user_id=user.id, purpose=PURPOSE_EMAIL_VERIFICATION
    )

    assert await consume_email_verification_token(session, raw_token=raw) is None


async def test_latest_token_created_at_returns_recent(session: AsyncSession) -> None:
    user = await make_user(session)
    await issue_email_verification_token(session, user=user, ttl_seconds=86400)

    created = await latest_token_created_at(
        session, email=user.email, purpose=PURPOSE_EMAIL_VERIFICATION
    )
    assert created is not None
