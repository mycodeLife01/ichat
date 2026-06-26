"""Redis-backed cooldown and IP rate limiting for auth email flows.

Redis is the short-TTL anti-abuse layer only; it never holds business state
(tokens, outbox, verification status live in PostgreSQL). Callers decide the
failure policy (fail-open vs fail-closed) per endpoint, so functions here raise
on Redis errors rather than swallowing them.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from collections.abc import Awaitable
from functools import lru_cache
from typing import NamedTuple, cast

from fastapi import Request
from redis.asyncio import Redis

from app.core.config import get_settings

# Atomic sliding-window counter. Removes entries older than the window, counts
# what remains, and admits the request only if under the limit. Returns
# {allowed (1/0), retry_after_seconds}.
_SLIDING_WINDOW_LUA = """
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, 0}
end
local earliest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = 1
if earliest[2] then
  retry = math.ceil((tonumber(earliest[2]) + window - now) / 1000)
  if retry < 1 then retry = 1 end
end
return {0, retry}
"""


class RateLimitResult(NamedTuple):
    allowed: bool
    retry_after_seconds: int


@lru_cache
def get_redis() -> Redis:
    client: Redis = Redis.from_url(get_settings().redis_url, decode_responses=True)
    return client


def client_ip_from_request(request: Request) -> str:
    """Real client IP.

    In production nginx realip rewrites the peer to the true client and forwards
    it as ``X-Real-IP``. In dev (no nginx) fall back to the socket peer.
    """
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


def _email_digest(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def cooldown_user_key(purpose: str, user_id: int) -> str:
    return f"auth:cooldown:{purpose}:user:{user_id}"


def cooldown_email_key(purpose: str, email: str) -> str:
    return f"auth:cooldown:{purpose}:email:{_email_digest(email)}"


def ip_rate_key(action: str, ip: str) -> str:
    return f"auth:rate:{action}:ip:{ip}"


async def try_cooldown(redis: Redis, key: str, ttl_seconds: int) -> bool:
    """Claim a cooldown slot. Returns False if one is already active.

    Uses ``SET key 1 NX EX ttl``. The caller must ``release_cooldown`` if the
    surrounding DB transaction later fails, so a no-op request does not lock the
    user out for the full TTL.
    """
    acquired = await redis.set(key, "1", nx=True, ex=ttl_seconds)
    return bool(acquired)


async def release_cooldown(redis: Redis, key: str) -> None:
    """Best-effort cooldown release; never raises."""
    try:
        await redis.delete(key)
    except Exception:  # noqa: BLE001 - release is best-effort
        pass


async def check_ip_rate_limit(
    redis: Redis, key: str, *, limit: int, window_seconds: int
) -> RateLimitResult:
    now_ms = int(time.time() * 1000)
    window_ms = window_seconds * 1000
    member = f"{now_ms}-{secrets.token_hex(6)}"
    raw = await cast(
        "Awaitable[list[int]]",
        redis.eval(
            _SLIDING_WINDOW_LUA, 1, key, str(now_ms), str(window_ms), str(limit), member
        ),
    )
    allowed, retry_after = int(raw[0]), int(raw[1])
    return RateLimitResult(allowed=allowed == 1, retry_after_seconds=retry_after)
