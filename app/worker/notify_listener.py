import asyncio
import contextlib

import asyncpg

from app.core.logging import logger

RUNS_QUEUED_CHANNEL = "runs_queued"


def _to_asyncpg_dsn(sqla_url: str) -> str:
    """Convert a SQLAlchemy async URL into a raw asyncpg DSN.

    e.g. ``postgresql+asyncpg://u:p@h:5432/db`` -> ``postgresql://u:p@h:5432/db``.
    """
    prefix = "postgresql+asyncpg://"
    if sqla_url.startswith(prefix):
        return "postgresql://" + sqla_url[len(prefix):]
    return sqla_url


class RunQueuedListener:
    """Dedicated asyncpg connection that LISTENs on ``runs_queued``.

    Notifications are coalesced into a single ``asyncio.Event``. The claim loop
    awaits ``wait_for_notify`` to get woken up the moment a new run is enqueued;
    a periodic fallback poll provides robustness if the LISTEN connection drops.
    """

    def __init__(self, database_url: str) -> None:
        self._dsn = _to_asyncpg_dsn(database_url)
        self._conn: asyncpg.Connection | None = None
        self._event = asyncio.Event()

    async def start(self) -> None:
        self._conn = await asyncpg.connect(self._dsn)
        await self._conn.add_listener(RUNS_QUEUED_CHANNEL, self._on_notify)
        logger.bind(channel=RUNS_QUEUED_CHANNEL).info("RunQueuedListener started")

    def _on_notify(
        self,
        connection: object,
        pid: int,
        channel: str,
        payload: str,
    ) -> None:
        self._event.set()

    async def wait_for_notify(self) -> None:
        """Block until at least one notification has arrived, then clear."""
        await self._event.wait()
        self._event.clear()

    async def stop(self) -> None:
        conn = self._conn
        self._conn = None
        if conn is None:
            return
        with contextlib.suppress(Exception):
            await conn.remove_listener(RUNS_QUEUED_CHANNEL, self._on_notify)
        with contextlib.suppress(Exception):
            await conn.close()
