"""Application use cases for email-verification auth flows."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from loguru import logger
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.user import User
from app.schemas.auth import AuthTokenResponse
from app.services.auth import rate_limit, verification
from app.services.auth.service import register_user
from app.tasks.email_tasks import send_email_outbox


@dataclass
class _EmailTransaction:
    cooldown_key: str | None = None
    outbox_id: int | None = None


def _dispatch_email(outbox_id: int) -> None:
    """Best-effort dispatch after the outbox transaction has committed."""
    try:
        send_email_outbox.delay(outbox_id)
    except Exception:  # noqa: BLE001 - the outbox sweep recovers broker failures
        logger.warning("Failed to enqueue email outbox {id}; sweep will recover", id=outbox_id)


@asynccontextmanager
async def _email_transaction(
    session: AsyncSession, redis: Redis
) -> AsyncIterator[_EmailTransaction]:
    transaction = _EmailTransaction()
    try:
        yield transaction
        await session.commit()
    except BaseException:
        try:
            await session.rollback()
        finally:
            if transaction.cooldown_key is not None:
                await rate_limit.release_cooldown(redis, transaction.cooldown_key)
        raise

    if transaction.outbox_id is not None:
        _dispatch_email(transaction.outbox_id)


async def register_with_verification(
    session: AsyncSession,
    redis: Redis,
    *,
    username: str,
    email: str,
    password: str,
    client_ip: str,
    settings: Settings,
) -> AuthTokenResponse:
    """Register a user and atomically persist the initial verification email."""
    await verification.register_ip_guard(redis, client_ip=client_ip, settings=settings)

    async with _email_transaction(session, redis) as transaction:
        token_response = await register_user(
            session,
            username=username,
            email=email,
            password=password,
            jwt_secret=settings.jwt_secret,
            access_token_ttl_seconds=settings.jwt_access_token_ttl_seconds,
            refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
        )
        user = await session.get(User, token_response.user.id)
        assert user is not None  # created and flushed by register_user
        transaction.cooldown_key = await verification.acquire_register_email_cooldown(
            session, redis, email=email, settings=settings
        )
        transaction.outbox_id = await verification.create_verification_email(
            session, user=user, settings=settings
        )

    return token_response


async def verify_email_address(
    session: AsyncSession,
    redis: Redis,
    *,
    raw_token: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Rate-limit, consume, and commit an email-verification token."""
    await verification.verify_ip_guard(redis, client_ip=client_ip, settings=settings)
    async with _email_transaction(session, redis):
        await verification.verify_email(session, raw_token=raw_token)


async def resend_verification_email(
    session: AsyncSession,
    redis: Redis,
    *,
    user: User,
    client_ip: str,
    settings: Settings,
) -> None:
    """Persist and dispatch a fresh verification email for an unverified user."""
    if user.email_verified:
        return

    cooldown_key = await verification.resend_guard(
        redis, user=user, client_ip=client_ip, settings=settings
    )
    async with _email_transaction(session, redis) as transaction:
        transaction.cooldown_key = cooldown_key
        transaction.outbox_id = await verification.create_verification_email_for_user(
            session, user_id=user.id, settings=settings
        )
