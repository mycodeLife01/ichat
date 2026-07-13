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
from app.services.auth.token_service import (
    PURPOSE_PASSWORD_RESET,
    issue_auth_token,
    latest_token_created_at,
)
from app.services.email.renderer import PASSWORD_RESET_SUBJECT, PASSWORD_RESET_TEMPLATE

COOLDOWN_MESSAGE = "Please wait before requesting another email"
RATE_LIMITED_MESSAGE = "Too many requests, please try again later"


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
