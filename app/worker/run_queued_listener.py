import asyncio
import contextlib

from redis.asyncio import Redis
from redis.asyncio.client import PubSub

from app.core.logging import logger
from app.services.runs.wakeup import RUNS_QUEUED_CHANNEL


class RunQueuedListener:
    """Redis pub/sub wakeup hint for the PostgreSQL-backed claim loop."""

    def __init__(
        self,
        *,
        redis: Redis | None = None,
        redis_url: str | None = None,
    ) -> None:
        if (redis is None) == (redis_url is None):
            raise ValueError("Pass exactly one of redis or redis_url")
        self._owns_redis = redis is None
        if redis is not None:
            self._redis = redis
        else:
            assert redis_url is not None
            self._redis = Redis.from_url(
                redis_url,
                decode_responses=True,
                socket_connect_timeout=0.2,
                socket_timeout=None,
                retry_on_timeout=False,
            )
        self._pubsub: PubSub | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._event = asyncio.Event()

    async def start(self) -> None:
        pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
        await pubsub.subscribe(RUNS_QUEUED_CHANNEL)
        self._pubsub = pubsub
        self._reader_task = asyncio.create_task(self._listen(pubsub))
        logger.bind(channel=RUNS_QUEUED_CHANNEL).info("RunQueuedListener started")

    async def _listen(self, pubsub: PubSub) -> None:
        try:
            async for message in pubsub.listen():
                if message.get("type") == "message":
                    self._event.set()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("RunQueuedListener connection failed; polling fallback remains active")

    async def wait_for_notify(self) -> None:
        await self._event.wait()
        self._event.clear()

    async def stop(self) -> None:
        task = self._reader_task
        self._reader_task = None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

        pubsub = self._pubsub
        self._pubsub = None
        if pubsub is not None:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(RUNS_QUEUED_CHANNEL)
            with contextlib.suppress(Exception):
                await pubsub.aclose()  # type: ignore[no-untyped-call]

        if self._owns_redis:
            await self._redis.aclose()
