from datetime import UTC, datetime, timedelta

import pytest
from fastapi import status

from app.core.errors import AppError
from app.services.auth.tokens import (
    create_access_token,
    create_refresh_token,
    decode_access_token,
    hash_refresh_token,
)

JWT_SECRET = "test-jwt-secret-with-at-least-32-bytes"


def test_create_access_token_can_be_decoded() -> None:
    token = create_access_token(
        user_id=123,
        secret=JWT_SECRET,
        ttl_seconds=900,
    )

    claims = decode_access_token(token, secret=JWT_SECRET)

    assert claims.user_id == 123


def test_decode_access_token_rejects_refresh_token_type() -> None:
    token = create_access_token(
        user_id=123,
        secret=JWT_SECRET,
        ttl_seconds=900,
        token_type="refresh",
    )

    with pytest.raises(AppError) as exc_info:
        decode_access_token(token, secret=JWT_SECRET)

    assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED
    assert exc_info.value.detail == "Invalid access token"


def test_decode_access_token_rejects_expired_token() -> None:
    token = create_access_token(
        user_id=123,
        secret=JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC) - timedelta(hours=1),
    )

    with pytest.raises(AppError) as exc_info:
        decode_access_token(token, secret=JWT_SECRET)

    assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED
    assert exc_info.value.detail == "Invalid access token"


def test_refresh_token_hash_is_stable_and_does_not_store_plaintext() -> None:
    token = create_refresh_token()

    assert hash_refresh_token(token) == hash_refresh_token(token)
    assert hash_refresh_token(token) != token
