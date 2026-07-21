import asyncio
import contextlib

from redis.asyncio import Redis
from redis.asyncio.client import PubSub

from app.core.logging import logger
from app.services.runs.wakeup import RUN_CANCEL_CHANNEL


class RunCancelListener:
    """Redis pub/sub cancel hint that interrupts a live run promptly.

    Each in-flight run registers its ``cancel`` event; a published run id sets
    the matching event so the executor stops without waiting for the heartbeat
    poll. Signals for unregistered runs are dropped — the heartbeat + PostgreSQL
    ``cancelling`` status remain the authoritative fallback.
    """

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
        self._events: dict[int, asyncio.Event] = {}

    def register(self, run_id: int, cancel: asyncio.Event) -> None:
        self._events[run_id] = cancel

    def unregister(self, run_id: int) -> None:
        self._events.pop(run_id, None)

    async def start(self) -> None:
        pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
        await pubsub.subscribe(RUN_CANCEL_CHANNEL)
        self._pubsub = pubsub
        self._reader_task = asyncio.create_task(self._listen(pubsub))
        logger.bind(channel=RUN_CANCEL_CHANNEL).info("RunCancelListener started")

    async def _listen(self, pubsub: PubSub) -> None:
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    run_id = int(message["data"])
                except (KeyError, TypeError, ValueError):
                    continue
                cancel = self._events.get(run_id)
                if cancel is not None:
                    cancel.set()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception(
                "RunCancelListener connection failed; heartbeat fallback remains active"
            )

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
                await pubsub.unsubscribe(RUN_CANCEL_CHANNEL)
            with contextlib.suppress(Exception):
                await pubsub.aclose()  # type: ignore[no-untyped-call]

        if self._owns_redis:
            await self._redis.aclose()
