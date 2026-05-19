import asyncio
import contextlib

import asyncpg

from app.core.logging import logger
from app.worker.notify_listener import _to_asyncpg_dsn

RUN_EVENTS_CHANNEL = "run_events"


class RunEventSubscriptionManager:
    """Process-wide LISTEN connection that fans out ``run_events`` notifications
    to per-run :class:`asyncio.Event` instances.

    SSE handlers obtain an Event via :meth:`subscribe` and clear/await on it.
    A single asyncpg connection is shared across all subscribers in the process,
    which is critical: opening a LISTEN connection per SSE request would exhaust
    Postgres connections under any meaningful client load.
    """

    def __init__(self, database_url: str) -> None:
        self._dsn = _to_asyncpg_dsn(database_url)
        self._conn: asyncpg.Connection | None = None
        self._subscribers: dict[int, set[asyncio.Event]] = {}

    async def start(self) -> None:
        self._conn = await asyncpg.connect(self._dsn)
        await self._conn.add_listener(RUN_EVENTS_CHANNEL, self._on_notify)
        logger.bind(channel=RUN_EVENTS_CHANNEL).info(
            "RunEventSubscriptionManager started"
        )

    def _on_notify(
        self,
        connection: object,
        pid: int,
        channel: str,
        payload: str,
    ) -> None:
        try:
            run_id = int(payload)
        except ValueError:
            return
        events = self._subscribers.get(run_id)
        if not events:
            return
        for event in events:
            event.set()

    def subscribe(self, run_id: int) -> asyncio.Event:
        event = asyncio.Event()
        self._subscribers.setdefault(run_id, set()).add(event)
        return event

    def unsubscribe(self, run_id: int, event: asyncio.Event) -> None:
        events = self._subscribers.get(run_id)
        if not events:
            return
        events.discard(event)
        if not events:
            self._subscribers.pop(run_id, None)

    async def stop(self) -> None:
        conn = self._conn
        self._conn = None
        if conn is None:
            return
        with contextlib.suppress(Exception):
            await conn.remove_listener(RUN_EVENTS_CHANNEL, self._on_notify)
        with contextlib.suppress(Exception):
            await conn.close()
        self._subscribers.clear()
