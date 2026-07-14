"""Password reset and account lifecycle flows (reset / change / deletion).

Domain operations and anti-abuse guards, combined into use cases by
app/services/auth/orchestration.py. Redis failure policy mirrors the
email-verification flows per endpoint (see the orchestration module docstring).
"""

from datetime import UTC, datetime, timedelta

from fastapi import status
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.models.email_outbox import EmailOutbox, OutboxStatus
from app.models.user import User
from app.services.auth import rate_limit
from app.services.auth.passwords import hash_password, verify_password
from app.services.auth.service import revoke_all_refresh_tokens
from app.services.auth.token_service import (
    PURPOSE_ACCOUNT_DELETION,
    PURPOSE_PASSWORD_RESET,
    consume_auth_token,
    issue_auth_token,
    latest_token_created_at,
    revoke_active_tokens,
    revoke_all_active_tokens,
)
from app.services.avatars.lifecycle import deactivate_user_avatar
from app.services.email.renderer import (
    ACCOUNT_DELETION_SUBJECT,
    ACCOUNT_DELETION_TEMPLATE,
    PASSWORD_RESET_SUBJECT,
    PASSWORD_RESET_TEMPLATE,
)

COOLDOWN_MESSAGE = "Please wait before requesting another email"
RATE_LIMITED_MESSAGE = "Too many requests, please try again later"
INVALID_RESET_MESSAGE = "Invalid or expired reset link"
INVALID_DELETION_MESSAGE = "Invalid or expired confirmation link"
INVALID_CURRENT_PASSWORD_MESSAGE = "Current password is incorrect"

CHANGE_PASSWORD_ACTION = "change_password"
DELETION_REQUEST_ACTION = "request_account_deletion"


def _too_many_requests(retry_after_seconds: int, detail: str) -> AppError:
    return AppError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        detail,
        headers={"Retry-After": str(retry_after_seconds)},
    )


async def find_active_user_by_email(session: AsyncSession, *, email: str) -> User | None:
    """Existing, non-deactivated user for an email; None otherwise.

    Deactivated accounts are indistinguishable from unknown emails on purpose:
    the anti-enumeration contract of request-password-reset covers both.
    """
    normalized_email = email.strip().lower()
    user = await session.scalar(
        select(User).where(func.lower(User.email) == normalized_email)
    )
    if user is None or not user.is_active:
        return None
    return user


async def password_reset_request_ip_guard(
    redis: Redis, *, client_ip: str, settings: Settings
) -> None:
    """IP flood protection for reset requests. Fails open on Redis outage."""
    try:
        result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key("request_password_reset", client_ip),
            limit=settings.auth_rate_password_reset_request_ip_limit,
            window_seconds=settings.auth_rate_password_reset_request_ip_window_seconds,
        )
        if not result.allowed:
            raise _too_many_requests(result.retry_after_seconds, RATE_LIMITED_MESSAGE)
    except AppError:
        raise
    except Exception:
        # The forgot-password path is the user's only self-rescue channel:
        # never hard-fail on Redis.
        logger.warning("Redis unavailable during password reset IP guard; failing open")


async def acquire_password_reset_cooldown(
    session: AsyncSession,
    redis: Redis,
    *,
    email: str,
    settings: Settings,
) -> str | None:
    """Per-email send cooldown for password reset requests.

    Claimed for every email — including unknown ones — so a 429 never leaks
    whether the address is registered. Returns the acquired cooldown key
    (release on rollback) or None when degraded. Raises 429 when blocked.
    """
    normalized_email = email.strip().lower()
    try:
        cooldown_key = rate_limit.cooldown_email_key(PURPOSE_PASSWORD_RESET, normalized_email)
        acquired = await rate_limit.try_cooldown(
            redis, cooldown_key, settings.auth_email_verification_cooldown_seconds
        )
        if not acquired:
            raise _too_many_requests(
                settings.auth_email_verification_cooldown_seconds, COOLDOWN_MESSAGE
            )
        return cooldown_key
    except AppError:
        raise
    except Exception:
        # Redis down: keep the self-rescue channel available. DB cooldown only
        # covers emails that already have token rows; unknown emails go
        # uncooled while degraded (response stays constant either way).
        logger.warning(
            "Redis unavailable during password reset cooldown; degrading to DB cooldown"
        )
        await _enforce_db_email_cooldown(
            session, normalized_email, purpose=PURPOSE_PASSWORD_RESET, settings=settings
        )
        return None


async def _enforce_db_email_cooldown(
    session: AsyncSession, normalized_email: str, *, purpose: str, settings: Settings
) -> None:
    last_created = await latest_token_created_at(
        session, email=normalized_email, purpose=purpose
    )
    if last_created is None:
        return
    threshold = datetime.now(UTC) - timedelta(
        seconds=settings.auth_email_verification_cooldown_seconds
    )
    if last_created > threshold:
        raise _too_many_requests(
            settings.auth_email_verification_cooldown_seconds, COOLDOWN_MESSAGE
        )


async def token_consume_ip_guard(
    redis: Redis, *, action: str, client_ip: str, settings: Settings
) -> None:
    """IP rate limit for token-consuming endpoints (verify-style limits).

    Fails open: a high-entropy single-use token must never be blocked by a
    Redis outage.
    """
    try:
        result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key(action, client_ip),
            limit=settings.auth_rate_verify_ip_limit,
            window_seconds=settings.auth_rate_verify_ip_window_seconds,
        )
        if not result.allowed:
            raise _too_many_requests(result.retry_after_seconds, RATE_LIMITED_MESSAGE)
    except AppError:
        raise
    except Exception:
        logger.warning("Redis unavailable during {action} IP guard; failing open", action=action)


async def _revoke_credentials_after_password_change(
    session: AsyncSession, *, user_id: int, now: datetime
) -> None:
    """Cross-invalidation matrix for a successful password change or reset:
    every refresh token (all devices) plus pending password_reset /
    account_deletion tokens.
    """
    await revoke_all_refresh_tokens(session, user_id=user_id, now=now)
    await revoke_active_tokens(
        session, user_id=user_id, purpose=PURPOSE_PASSWORD_RESET, now=now
    )
    await revoke_active_tokens(
        session, user_id=user_id, purpose=PURPOSE_ACCOUNT_DELETION, now=now
    )


async def reset_password(
    session: AsyncSession, *, raw_token: str, new_password: str, now: datetime | None = None
) -> None:
    """Consume a password_reset token and set the new password.

    Also enforces the cross-invalidation matrix (all refresh tokens plus
    pending password_reset / account_deletion tokens) and, when the token was
    sent to the user's current email, counts as an email verification (see
    CONTEXT.md).
    """
    moment = now or datetime.now(UTC)
    consumed = await consume_auth_token(
        session, raw_token=raw_token, purpose=PURPOSE_PASSWORD_RESET, now=moment
    )
    if consumed is None:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_RESET_MESSAGE)
    user_id, sent_to_email = consumed
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_RESET_MESSAGE)

    user.password_hash = hash_password(new_password)
    if sent_to_email == user.email:
        user.email_verified = True
    await _revoke_credentials_after_password_change(session, user_id=user.id, now=moment)
    await session.flush()


async def change_password_guard(
    redis: Redis, *, user_id: int, client_ip: str, settings: Settings
) -> None:
    """Anti-brute-force for change-password. Fails closed on Redis outage.

    Two dimensions: an IP sliding window plus a per-user failed-attempt budget
    (only wrong-password attempts consume it, recorded inside ``change_password``).
    """
    try:
        ip_result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key(CHANGE_PASSWORD_ACTION, client_ip),
            limit=settings.auth_rate_password_change_ip_limit,
            window_seconds=settings.auth_rate_password_change_ip_window_seconds,
        )
        if not ip_result.allowed:
            raise _too_many_requests(ip_result.retry_after_seconds, RATE_LIMITED_MESSAGE)
        budget = await rate_limit.check_failure_budget(
            redis,
            rate_limit.failure_key(CHANGE_PASSWORD_ACTION, user_id),
            limit=settings.auth_rate_password_change_user_limit,
        )
        if not budget.allowed:
            raise _too_many_requests(budget.retry_after_seconds, RATE_LIMITED_MESSAGE)
    except AppError:
        raise
    except Exception:
        # A password-bearing endpoint must not become an uncounted oracle
        # while Redis is down.
        logger.warning("Redis unavailable during change-password guard; failing closed")
        raise _too_many_requests(
            settings.auth_rate_password_change_user_window_seconds, RATE_LIMITED_MESSAGE
        ) from None


async def change_password(
    session: AsyncSession,
    redis: Redis,
    *,
    user: User,
    current_password: str,
    new_password: str,
    settings: Settings,
    now: datetime | None = None,
) -> None:
    """Verify the current password and set the new one.

    A wrong current password consumes the caller's failure budget. Success
    enforces the cross-invalidation matrix: every refresh token (all devices,
    including the current one) plus pending password_reset / account_deletion
    tokens.
    """
    moment = now or datetime.now(UTC)
    if not verify_password(current_password, user.password_hash):
        await rate_limit.record_failure(
            redis,
            rate_limit.failure_key(CHANGE_PASSWORD_ACTION, user.id),
            window_seconds=settings.auth_rate_password_change_user_window_seconds,
        )
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_CURRENT_PASSWORD_MESSAGE)

    user.password_hash = hash_password(new_password)
    await _revoke_credentials_after_password_change(session, user_id=user.id, now=moment)
    await session.flush()


async def create_password_reset_email(
    session: AsyncSession, *, user: User, settings: Settings, now: datetime | None = None
) -> int:
    """Issue a password_reset token and enqueue an outbox row. Returns outbox id."""
    moment = now or datetime.now(UTC)
    ttl = settings.auth_password_reset_token_ttl_seconds
    raw_token = await issue_auth_token(
        session, user=user, purpose=PURPOSE_PASSWORD_RESET, ttl_seconds=ttl, now=moment
    )
    reset_url = f"{settings.frontend_app_url.rstrip('/')}/reset-password?token={raw_token}"
    outbox = EmailOutbox(
        kind=PURPOSE_PASSWORD_RESET,
        recipient_email=user.email,
        subject=PASSWORD_RESET_SUBJECT,
        template=PASSWORD_RESET_TEMPLATE,
        payload={
            "reset_url": reset_url,
            "username": user.username,
            "expires_in_minutes": ttl // 60,
        },
        status=OutboxStatus.PENDING,
        next_attempt_at=moment,
    )
    session.add(outbox)
    await session.flush()
    return outbox.id


async def deletion_request_ip_guard(
    redis: Redis, *, client_ip: str, settings: Settings
) -> None:
    """IP rate limit for deletion requests, ahead of the password check.

    Fails closed: deleting an account is never urgent, and a password-bearing
    endpoint must not become an uncounted oracle while Redis is down.
    """
    try:
        result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key(DELETION_REQUEST_ACTION, client_ip),
            limit=settings.auth_rate_deletion_request_ip_limit,
            window_seconds=settings.auth_rate_deletion_request_ip_window_seconds,
        )
        if not result.allowed:
            raise _too_many_requests(result.retry_after_seconds, RATE_LIMITED_MESSAGE)
    except AppError:
        raise
    except Exception:
        logger.warning("Redis unavailable during deletion request IP guard; failing closed")
        raise _too_many_requests(
            settings.auth_email_verification_cooldown_seconds, RATE_LIMITED_MESSAGE
        ) from None


def verify_sudo_password(*, user: User, password: str) -> None:
    """Re-prove identity for a sensitive action: logged-in is not enough."""
    if not verify_password(password, user.password_hash):
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_CURRENT_PASSWORD_MESSAGE)


async def acquire_deletion_cooldowns(
    redis: Redis, *, user: User, settings: Settings
) -> list[str]:
    """User + email send cooldowns for deletion confirmation emails.

    Fails closed (mirrors resend). Returns the acquired keys so the caller can
    release them if the surrounding transaction rolls back.
    """
    acquired_keys: list[str] = []
    try:
        cooldown_keys = [
            rate_limit.cooldown_user_key(PURPOSE_ACCOUNT_DELETION, user.id),
            rate_limit.cooldown_email_key(PURPOSE_ACCOUNT_DELETION, user.email),
        ]
        for cooldown_key in cooldown_keys:
            acquired = await rate_limit.try_cooldown(
                redis, cooldown_key, settings.auth_email_verification_cooldown_seconds
            )
            if not acquired:
                raise _too_many_requests(
                    settings.auth_email_verification_cooldown_seconds, COOLDOWN_MESSAGE
                )
            acquired_keys.append(cooldown_key)
        return acquired_keys
    except AppError:
        for cooldown_key in acquired_keys:
            await rate_limit.release_cooldown(redis, cooldown_key)
        raise
    except Exception:
        for cooldown_key in acquired_keys:
            await rate_limit.release_cooldown(redis, cooldown_key)
        logger.warning("Redis unavailable during deletion cooldown; failing closed")
        raise _too_many_requests(
            settings.auth_email_verification_cooldown_seconds, RATE_LIMITED_MESSAGE
        ) from None


async def create_account_deletion_email(
    session: AsyncSession, *, user: User, settings: Settings, now: datetime | None = None
) -> int:
    """Issue an account_deletion token and enqueue an outbox row. Returns outbox id."""
    moment = now or datetime.now(UTC)
    ttl = settings.auth_account_deletion_token_ttl_seconds
    raw_token = await issue_auth_token(
        session, user=user, purpose=PURPOSE_ACCOUNT_DELETION, ttl_seconds=ttl, now=moment
    )
    deletion_url = (
        f"{settings.frontend_app_url.rstrip('/')}/confirm-account-deletion?token={raw_token}"
    )
    outbox = EmailOutbox(
        kind=PURPOSE_ACCOUNT_DELETION,
        recipient_email=user.email,
        subject=ACCOUNT_DELETION_SUBJECT,
        template=ACCOUNT_DELETION_TEMPLATE,
        payload={
            "deletion_url": deletion_url,
            "username": user.username,
            "expires_in_minutes": ttl // 60,
        },
        status=OutboxStatus.PENDING,
        next_attempt_at=moment,
    )
    session.add(outbox)
    await session.flush()
    return outbox.id


async def confirm_account_deletion(
    session: AsyncSession,
    *,
    raw_token: str,
    settings: Settings,
    now: datetime | None = None,
) -> None:
    """Consume an account_deletion token and soft-delete the account.

    Deactivation (is_active=False) is the whole enforcement surface: login,
    refresh, and the current-user dependency all reject inactive users. Data
    stays in place — physical erasure is a later, separate stage (see the
    account-deletion ADR). Every credential goes: all refresh tokens and all
    active auth tokens of every purpose.
    """
    moment = now or datetime.now(UTC)
    consumed = await consume_auth_token(
        session, raw_token=raw_token, purpose=PURPOSE_ACCOUNT_DELETION, now=moment
    )
    if consumed is None:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_DELETION_MESSAGE)
    user_id, _sent_to_email = consumed
    user = await session.get(User, user_id)
    if user is None:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_DELETION_MESSAGE)

    user.is_active = False
    await deactivate_user_avatar(session, user=user, settings=settings, now=moment)
    await revoke_all_refresh_tokens(session, user_id=user.id, now=moment)
    await revoke_all_active_tokens(session, user_id=user.id, now=moment)
    await session.flush()
