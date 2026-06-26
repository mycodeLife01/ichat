import pytest
from fakeredis import aioredis
from starlette.requests import Request

from app.services.auth.rate_limit import (
    check_ip_rate_limit,
    client_ip_from_request,
    cooldown_email_key,
    release_cooldown,
    try_cooldown,
)


@pytest.fixture
def redis() -> aioredis.FakeRedis:
    return aioredis.FakeRedis(decode_responses=True)


def _request(headers: list[tuple[bytes, bytes]], client: tuple[str, int] | None) -> Request:
    return Request({"type": "http", "headers": headers, "client": client})


def test_client_ip_prefers_x_real_ip() -> None:
    request = _request([(b"x-real-ip", b"1.2.3.4")], ("9.9.9.9", 100))
    assert client_ip_from_request(request) == "1.2.3.4"


def test_client_ip_falls_back_to_peer() -> None:
    request = _request([], ("9.9.9.9", 100))
    assert client_ip_from_request(request) == "9.9.9.9"


def test_client_ip_unknown_when_no_peer() -> None:
    request = _request([], None)
    assert client_ip_from_request(request) == "unknown"


async def test_try_cooldown_blocks_second_call(redis: aioredis.FakeRedis) -> None:
    key = cooldown_email_key("email_verification", "Alice@Example.com")

    assert await try_cooldown(redis, key, ttl_seconds=60) is True
    assert await try_cooldown(redis, key, ttl_seconds=60) is False


async def test_release_cooldown_frees_slot(redis: aioredis.FakeRedis) -> None:
    key = cooldown_email_key("email_verification", "alice@example.com")

    assert await try_cooldown(redis, key, ttl_seconds=60) is True
    await release_cooldown(redis, key)
    assert await try_cooldown(redis, key, ttl_seconds=60) is True


async def test_email_cooldown_key_is_normalized(redis: aioredis.FakeRedis) -> None:
    # Same email differing in case/whitespace maps to one key.
    assert cooldown_email_key("email_verification", " Alice@Example.com ") == cooldown_email_key(
        "email_verification", "alice@example.com"
    )


async def test_ip_rate_limit_allows_up_to_limit_then_denies(
    redis: aioredis.FakeRedis,
) -> None:
    key = "auth:rate:resend_verification:ip:1.2.3.4"

    for _ in range(3):
        result = await check_ip_rate_limit(redis, key, limit=3, window_seconds=3600)
        assert result.allowed is True

    denied = await check_ip_rate_limit(redis, key, limit=3, window_seconds=3600)
    assert denied.allowed is False
    assert denied.retry_after_seconds > 0
