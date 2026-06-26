"""Issuance and verification of auth_tokens.

Only the SHA-256 hex digest of the raw token is stored; the raw token appears
once, in the verification email link. Mirrors the refresh-token hashing in
app/services/auth/tokens.py.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_token import AuthToken
from app.models.user import User

PURPOSE_EMAIL_VERIFICATION = "email_verification"


def hash_auth_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


async def revoke_active_tokens(
    session: AsyncSession, *, user_id: int, purpose: str, now: datetime | None = None
) -> None:
    moment = now or datetime.now(UTC)
    await session.execute(
        update(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == purpose,
            AuthToken.used_at.is_(None),
            AuthToken.revoked_at.is_(None),
        )
        .values(revoked_at=moment)
    )


async def issue_email_verification_token(
    session: AsyncSession, *, user: User, ttl_seconds: int, now: datetime | None = None
) -> str:
    """Revoke any active verification token, then mint a fresh one.

    Returns the raw token (caller embeds it in the email link). Only the hash is
    persisted.
    """
    moment = now or datetime.now(UTC)
    await revoke_active_tokens(
        session, user_id=user.id, purpose=PURPOSE_EMAIL_VERIFICATION, now=moment
    )
    raw_token = secrets.token_urlsafe(32)
    session.add(
        AuthToken(
            user_id=user.id,
            purpose=PURPOSE_EMAIL_VERIFICATION,
            token_hash=hash_auth_token(raw_token),
            sent_to_email=user.email,
            expires_at=moment + timedelta(seconds=ttl_seconds),
        )
    )
    await session.flush()
    return raw_token


async def consume_email_verification_token(
    session: AsyncSession, *, raw_token: str, now: datetime | None = None
) -> tuple[int, str] | None:
    """Atomically mark a valid verification token used.

    Returns ``(user_id, sent_to_email)`` on success, ``None`` if the token is
    missing/expired/used/revoked. The single UPDATE guards against concurrent
    double-clicks: only one caller wins the row.
    """
    moment = now or datetime.now(UTC)
    result = await session.execute(
        update(AuthToken)
        .where(
            AuthToken.token_hash == hash_auth_token(raw_token),
            AuthToken.purpose == PURPOSE_EMAIL_VERIFICATION,
            AuthToken.used_at.is_(None),
            AuthToken.revoked_at.is_(None),
            AuthToken.expires_at > moment,
        )
        .values(used_at=moment)
        .returning(AuthToken.user_id, AuthToken.sent_to_email)
    )
    row = result.first()
    if row is None:
        return None
    return (row[0], row[1])


async def latest_token_created_at(
    session: AsyncSession, *, email: str, purpose: str
) -> datetime | None:
    """Most recent token creation time for an email (DB cooldown fallback)."""
    created_at: datetime | None = await session.scalar(
        select(AuthToken.created_at)
        .where(AuthToken.sent_to_email == email, AuthToken.purpose == purpose)
        .order_by(AuthToken.created_at.desc())
        .limit(1)
    )
    return created_at
