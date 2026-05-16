import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any

import jwt
from fastapi import status
from jwt import InvalidTokenError

from app.core.errors import AppError

ACCESS_TOKEN_TYPE = "access"


@dataclass(frozen=True)
class AccessTokenClaims:
    user_id: int


def create_access_token(
    *,
    user_id: int,
    secret: str,
    ttl_seconds: int,
    now: datetime | None = None,
    token_type: str = ACCESS_TOKEN_TYPE,
) -> str:
    issued_at = now or datetime.now(UTC)
    expires_at = issued_at + timedelta(seconds=ttl_seconds)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "type": token_type,
        "iat": issued_at,
        "exp": expires_at,
        "jti": secrets.token_urlsafe(16),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_access_token(token: str, *, secret: str) -> AccessTokenClaims:
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
        if payload.get("type") != ACCESS_TOKEN_TYPE:
            raise InvalidTokenError
        subject = payload.get("sub")
        if not isinstance(subject, str):
            raise InvalidTokenError
        return AccessTokenClaims(user_id=int(subject))
    except (InvalidTokenError, ValueError):
        raise AppError(status.HTTP_401_UNAUTHORIZED, "Invalid access token") from None


def create_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def hash_refresh_token(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()
