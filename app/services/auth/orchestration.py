"""Application use cases for auth email and account lifecycle flows.

Email verification (register / resend / verify) plus password reset, password
change, and account deletion. Each use case combines the domain operations in
verification.py / account.py with Redis anti-abuse guards and a single
commit/rollback boundary (cooldown keys are released on rollback).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from loguru import logger
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.user import User
from app.schemas.auth import AuthTokenResponse
from app.services.auth import account, rate_limit, verification
from app.services.auth.service import register_user
from app.tasks.email_tasks import send_email_outbox


@dataclass
class _EmailTransaction:
    cooldown_keys: list[str] = field(default_factory=list)
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
            for cooldown_key in transaction.cooldown_keys:
                await rate_limit.release_cooldown(redis, cooldown_key)
        raise

    if transaction.outbox_id is not None:
        _dispatch_email(transaction.outbox_id)


async def register_with_verification(
    session: AsyncSession,
    redis: Redis,
    *,
    username: str,
    nickname: str | None = None,
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
            nickname=nickname,
            email=email,
            password=password,
            jwt_secret=settings.jwt_secret,
            access_token_ttl_seconds=settings.jwt_access_token_ttl_seconds,
            refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
        )
        user = await session.get(User, token_response.user.id)
        assert user is not None  # created and flushed by register_user
        cooldown_key = await verification.acquire_register_email_cooldown(
            session, redis, email=email, settings=settings
        )
        if cooldown_key is not None:
            transaction.cooldown_keys.append(cooldown_key)
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

    async with _email_transaction(session, redis) as transaction:
        locked_user = await verification.lock_unverified_user(session, user_id=user.id)
        if locked_user is None:
            return
        cooldown_keys = await verification.resend_guard(
            redis, user=locked_user, client_ip=client_ip, settings=settings
        )
        transaction.cooldown_keys.extend(cooldown_keys)
        transaction.outbox_id = await verification.create_verification_email(
            session, user=locked_user, settings=settings
        )


async def request_password_reset(
    session: AsyncSession,
    redis: Redis,
    *,
    email: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Anti-enumeration reset request: constant outcome for any email.

    The cooldown is claimed before the existence check so unknown emails burn
    the same 429 budget as registered ones. Only an existing, active user gets
    a token and an outbox row.
    """
    await account.password_reset_request_ip_guard(
        redis, client_ip=client_ip, settings=settings
    )

    async with _email_transaction(session, redis) as transaction:
        cooldown_key = await account.acquire_password_reset_cooldown(
            session, redis, email=email, settings=settings
        )
        if cooldown_key is not None:
            transaction.cooldown_keys.append(cooldown_key)
        user = await account.find_active_user_by_email(session, email=email)
        if user is None:
            return
        transaction.outbox_id = await account.create_password_reset_email(
            session, user=user, settings=settings
        )


async def reset_password(
    session: AsyncSession,
    redis: Redis,
    *,
    raw_token: str,
    new_password: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Rate-limit, consume the reset token, and commit the new password."""
    await account.token_consume_ip_guard(
        redis, action="reset_password", client_ip=client_ip, settings=settings
    )
    async with _email_transaction(session, redis):
        await account.reset_password(
            session, raw_token=raw_token, new_password=new_password
        )


async def change_password(
    session: AsyncSession,
    redis: Redis,
    *,
    user: User,
    current_password: str,
    new_password: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Guard against online brute force, then rotate the password."""
    await account.change_password_guard(
        redis, user_id=user.id, client_ip=client_ip, settings=settings
    )
    async with _email_transaction(session, redis):
        await account.change_password(
            session,
            redis,
            user=user,
            current_password=current_password,
            new_password=new_password,
            settings=settings,
        )


async def request_account_deletion(
    session: AsyncSession,
    redis: Redis,
    *,
    user: User,
    password: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Sudo-check the password, then send the deletion confirmation email.

    The IP guard runs before the password check so a stolen session cannot
    guess passwords faster than the window allows.
    """
    await account.deletion_request_ip_guard(redis, client_ip=client_ip, settings=settings)
    account.verify_sudo_password(user=user, password=password)

    async with _email_transaction(session, redis) as transaction:
        cooldown_keys = await account.acquire_deletion_cooldowns(
            redis, user=user, settings=settings
        )
        transaction.cooldown_keys.extend(cooldown_keys)
        transaction.outbox_id = await account.create_account_deletion_email(
            session, user=user, settings=settings
        )


async def confirm_account_deletion(
    session: AsyncSession,
    redis: Redis,
    *,
    raw_token: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Rate-limit, consume the deletion token, and commit the deactivation."""
    await account.token_consume_ip_guard(
        redis, action="confirm_account_deletion", client_ip=client_ip, settings=settings
    )
    async with _email_transaction(session, redis):
        await account.confirm_account_deletion(
            session, raw_token=raw_token, settings=settings
        )
