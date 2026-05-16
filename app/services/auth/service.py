from datetime import UTC, datetime, timedelta

from fastapi import status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.user import RefreshToken, User
from app.schemas.auth import AuthTokenResponse, AuthUserResponse, CommandStatusResponse
from app.services.auth.passwords import hash_password, verify_password
from app.services.auth.tokens import create_access_token, create_refresh_token, hash_refresh_token

INVALID_LOGIN_MESSAGE = "Invalid username, email, or password"
INVALID_REFRESH_TOKEN_MESSAGE = "Invalid refresh token"


def user_response(user: User) -> AuthUserResponse:
    return AuthUserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        email_verified=user.email_verified,
    )


async def register_user(
    session: AsyncSession,
    *,
    username: str,
    email: str,
    password: str,
    jwt_secret: str,
    access_token_ttl_seconds: int,
    refresh_token_ttl_seconds: int,
) -> AuthTokenResponse:
    normalized_username = username.strip()
    normalized_email = email.strip().lower()

    existing_username = await session.scalar(
        select(User.id).where(func.lower(User.username) == normalized_username.lower())
    )
    if existing_username is not None:
        raise AppError(status.HTTP_409_CONFLICT, "Username is already registered")

    existing_email = await session.scalar(
        select(User.id).where(func.lower(User.email) == normalized_email.lower())
    )
    if existing_email is not None:
        raise AppError(status.HTTP_409_CONFLICT, "Email is already registered")

    user = User(
        username=normalized_username,
        email=normalized_email,
        password_hash=hash_password(password),
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    return await issue_tokens(
        session,
        user=user,
        jwt_secret=jwt_secret,
        access_token_ttl_seconds=access_token_ttl_seconds,
        refresh_token_ttl_seconds=refresh_token_ttl_seconds,
    )


async def login_user(
    session: AsyncSession,
    *,
    identifier: str,
    password: str,
    jwt_secret: str,
    access_token_ttl_seconds: int,
    refresh_token_ttl_seconds: int,
) -> AuthTokenResponse:
    normalized_identifier = identifier.strip().lower()
    user = await session.scalar(
        select(User).where(
            or_(
                func.lower(User.username) == normalized_identifier,
                func.lower(User.email) == normalized_identifier,
            )
        )
    )
    if user is None or not user.is_active:
        raise AppError(status.HTTP_401_UNAUTHORIZED, INVALID_LOGIN_MESSAGE)
    if not verify_password(password, user.password_hash):
        raise AppError(status.HTTP_401_UNAUTHORIZED, INVALID_LOGIN_MESSAGE)

    return await issue_tokens(
        session,
        user=user,
        jwt_secret=jwt_secret,
        access_token_ttl_seconds=access_token_ttl_seconds,
        refresh_token_ttl_seconds=refresh_token_ttl_seconds,
    )


async def refresh_tokens(
    session: AsyncSession,
    *,
    refresh_token: str,
    jwt_secret: str,
    access_token_ttl_seconds: int,
    refresh_token_ttl_seconds: int,
) -> AuthTokenResponse:
    now = datetime.now(UTC)
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(refresh_token))
    )
    if token is None or token.revoked_at is not None or token.expires_at <= now:
        raise AppError(status.HTTP_401_UNAUTHORIZED, INVALID_REFRESH_TOKEN_MESSAGE)

    user = await session.get(User, token.user_id)
    if user is None or not user.is_active:
        raise AppError(status.HTTP_401_UNAUTHORIZED, INVALID_REFRESH_TOKEN_MESSAGE)

    token.revoked_at = now
    return await issue_tokens(
        session,
        user=user,
        jwt_secret=jwt_secret,
        access_token_ttl_seconds=access_token_ttl_seconds,
        refresh_token_ttl_seconds=refresh_token_ttl_seconds,
        now=now,
    )


async def logout(session: AsyncSession, *, refresh_token: str) -> CommandStatusResponse:
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(refresh_token))
    )
    if token is not None and token.revoked_at is None:
        token.revoked_at = datetime.now(UTC)
        await session.flush()
    return CommandStatusResponse()


async def issue_tokens(
    session: AsyncSession,
    *,
    user: User,
    jwt_secret: str,
    access_token_ttl_seconds: int,
    refresh_token_ttl_seconds: int,
    now: datetime | None = None,
) -> AuthTokenResponse:
    issued_at = now or datetime.now(UTC)
    access_token = create_access_token(
        user_id=user.id,
        secret=jwt_secret,
        ttl_seconds=access_token_ttl_seconds,
        now=issued_at,
    )
    refresh_token = create_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_refresh_token(refresh_token),
            expires_at=issued_at + timedelta(seconds=refresh_token_ttl_seconds),
        )
    )
    await session.flush()

    return AuthTokenResponse(
        user=user_response(user),
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=access_token_ttl_seconds,
    )
