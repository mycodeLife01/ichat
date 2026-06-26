"""Registration / resend / verification orchestration for email verification.

Combines auth_tokens, email_outbox, and Redis anti-abuse. Per-endpoint Redis
failure policy:
- register: graceful degrade (email cooldown via DB, IP fail-open)
- resend:   fail closed (deny)
- verify:   fail open (never block a high-entropy token on Redis outage)
"""

from datetime import UTC, datetime, timedelta

from fastapi import status
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.models.email_outbox import EmailOutbox
from app.models.user import User
from app.services.auth import rate_limit
from app.services.auth.token_service import (
    PURPOSE_EMAIL_VERIFICATION,
    consume_email_verification_token,
    issue_email_verification_token,
    latest_token_created_at,
)
from app.services.email.renderer import EMAIL_VERIFICATION_SUBJECT, EMAIL_VERIFICATION_TEMPLATE

INVALID_VERIFICATION_MESSAGE = "Invalid or expired verification link"
COOLDOWN_MESSAGE = "Please wait before requesting another verification email"
RATE_LIMITED_MESSAGE = "Too many requests, please try again later"


def _too_many_requests(retry_after_seconds: int, detail: str) -> AppError:
    return AppError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        detail,
        headers={"Retry-After": str(retry_after_seconds)},
    )


async def create_verification_email(
    session: AsyncSession, *, user: User, settings: Settings, now: datetime | None = None
) -> int:
    """Issue a verification token and enqueue an outbox row. Returns outbox id."""
    moment = now or datetime.now(UTC)
    ttl = settings.auth_email_verification_token_ttl_seconds
    raw_token = await issue_email_verification_token(
        session, user=user, ttl_seconds=ttl, now=moment
    )
    verification_url = (
        f"{settings.frontend_app_url.rstrip('/')}/verify-email?token={raw_token}"
    )
    outbox = EmailOutbox(
        kind=PURPOSE_EMAIL_VERIFICATION,
        recipient_email=user.email,
        subject=EMAIL_VERIFICATION_SUBJECT,
        template=EMAIL_VERIFICATION_TEMPLATE,
        payload={
            "verification_url": verification_url,
            "username": user.username,
            "expires_in_hours": ttl // 3600,
        },
        status="pending",
        next_attempt_at=moment,
    )
    session.add(outbox)
    await session.flush()
    return outbox.id


async def verify_email(
    session: AsyncSession, *, raw_token: str, now: datetime | None = None
) -> None:
    """Consume the token and flip email_verified. Generic failure on any problem."""
    moment = now or datetime.now(UTC)
    consumed = await consume_email_verification_token(session, raw_token=raw_token, now=moment)
    if consumed is None:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_VERIFICATION_MESSAGE)
    user_id, sent_to_email = consumed
    user = await session.get(User, user_id)
    if user is None:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_VERIFICATION_MESSAGE)
    if user.email_verified:
        return  # idempotent: already verified
    if sent_to_email != user.email:
        # Defensive: cannot happen today (no email-change flow).
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_VERIFICATION_MESSAGE)
    user.email_verified = True
    await session.flush()


async def register_ip_guard(
    redis: Redis, *, client_ip: str, settings: Settings
) -> None:
    """IP flood protection for register. Fails open when Redis is unavailable."""
    try:
        ip_result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key("register", client_ip),
            limit=settings.auth_rate_register_ip_limit,
            window_seconds=settings.auth_rate_register_ip_window_seconds,
        )
        if not ip_result.allowed:
            raise _too_many_requests(ip_result.retry_after_seconds, RATE_LIMITED_MESSAGE)
    except AppError:
        raise
    except Exception:
        # Register is the conversion-critical path: never hard-fail on Redis.
        logger.warning("Redis unavailable during register IP guard; failing open")


async def acquire_register_email_cooldown(
    session: AsyncSession,
    redis: Redis,
    *,
    email: str,
    settings: Settings,
) -> str | None:
    """Per-email send cooldown for register.

    Called only after the unique-email check passes (so a duplicate email still
    returns 409 rather than being masked by a 429). Returns the acquired cooldown
    key (release on rollback) or None when degraded. Raises 429 when blocked.
    """
    normalized_email = email.strip().lower()
    try:
        cooldown_key = rate_limit.cooldown_email_key(PURPOSE_EMAIL_VERIFICATION, normalized_email)
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
        # Redis down: keep registration available. Email cooldown via DB.
        logger.warning("Redis unavailable during register cooldown; degrading to DB cooldown")
        await _enforce_db_email_cooldown(session, normalized_email, settings)
        return None


async def _enforce_db_email_cooldown(
    session: AsyncSession, normalized_email: str, settings: Settings
) -> None:
    last_created = await latest_token_created_at(
        session, email=normalized_email, purpose=PURPOSE_EMAIL_VERIFICATION
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


async def resend_guard(
    redis: Redis,
    *,
    user: User,
    client_ip: str,
    settings: Settings,
) -> str | None:
    """Anti-abuse for resend. Fails closed when Redis is unavailable."""
    try:
        ip_result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key("resend_verification", client_ip),
            limit=settings.auth_rate_resend_ip_limit,
            window_seconds=settings.auth_rate_resend_ip_window_seconds,
        )
        if not ip_result.allowed:
            raise _too_many_requests(ip_result.retry_after_seconds, RATE_LIMITED_MESSAGE)
        cooldown_key = rate_limit.cooldown_user_key(PURPOSE_EMAIL_VERIFICATION, user.id)
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
        logger.warning("Redis unavailable during resend guard; failing closed")
        raise _too_many_requests(
            settings.auth_email_verification_cooldown_seconds, RATE_LIMITED_MESSAGE
        ) from None


async def verify_ip_guard(
    redis: Redis, *, client_ip: str, settings: Settings
) -> None:
    """IP rate limit for verify. Fails open when Redis is unavailable."""
    try:
        result = await rate_limit.check_ip_rate_limit(
            redis,
            rate_limit.ip_rate_key("verify_email", client_ip),
            limit=settings.auth_rate_verify_ip_limit,
            window_seconds=settings.auth_rate_verify_ip_window_seconds,
        )
        if not result.allowed:
            raise _too_many_requests(result.retry_after_seconds, RATE_LIMITED_MESSAGE)
    except AppError:
        raise
    except Exception:
        logger.warning("Redis unavailable during verify; failing open")


async def create_verification_email_for_user(
    session: AsyncSession, *, user_id: int, settings: Settings
) -> int | None:
    """Lock the user row, re-check verification, then issue a fresh email.

    Returns the outbox id, or None if the user vanished or is already verified
    (idempotent under concurrent resends).
    """
    user = await session.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None or user.email_verified:
        return None
    return await create_verification_email(session, user=user, settings=settings)
