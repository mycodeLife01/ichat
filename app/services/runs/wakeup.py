from typing import Protocol

from redis.asyncio import Redis

from app.core.config import Settings

RUNS_QUEUED_CHANNEL = "runs_queued"
RUN_CANCEL_CHANNEL = "run_cancel"


class RunQueuedPublisher(Protocol):
    async def publish(self, run_id: int) -> None: ...


class RunCancelPublisher(Protocol):
    async def publish(self, run_id: int) -> None: ...


class RedisRunQueuedPublisher:
    def __init__(self, *, redis: Redis) -> None:
        self._redis = redis

    @classmethod
    def from_settings(cls, settings: Settings) -> "RedisRunQueuedPublisher":
        redis: Redis = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=0.2,
            socket_timeout=0.2,
            retry_on_timeout=False,
        )
        return cls(redis=redis)

    async def publish(self, run_id: int) -> None:
        await self._redis.publish(RUNS_QUEUED_CHANNEL, str(run_id))

    async def close(self) -> None:
        await self._redis.aclose()


class RedisRunCancelPublisher:
    """Prompt cancel hint so the worker interrupts a live run without waiting for
    the heartbeat poll. Best-effort; PostgreSQL ``cancelling`` status + heartbeat
    remain the authoritative fallback."""

    def __init__(self, *, redis: Redis) -> None:
        self._redis = redis

    @classmethod
    def from_settings(cls, settings: Settings) -> "RedisRunCancelPublisher":
        redis: Redis = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=0.2,
            socket_timeout=0.2,
            retry_on_timeout=False,
        )
        return cls(redis=redis)

    async def publish(self, run_id: int) -> None:
        await self._redis.publish(RUN_CANCEL_CHANNEL, str(run_id))

    async def close(self) -> None:
        await self._redis.aclose()
