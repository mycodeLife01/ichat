import asyncio
import contextlib
import os
import socket
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging, logger
from app.db.session import get_session_factory
from app.providers import resolve_provider as default_resolve_provider
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    recover_expired_runs,
)
from app.worker.executor import ProviderResolver, execute_run
from app.worker.notify_listener import RunQueuedListener

DEFAULT_RECOVERY_INTERVAL_SECONDS = 15.0


def build_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}-{uuid4().hex[:8]}"


async def run_worker_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    worker_id: str,
    resolve_provider: ProviderResolver,
    stop_event: asyncio.Event,
    recovery_interval_seconds: float = DEFAULT_RECOVERY_INTERVAL_SECONDS,
    notify_listener: RunQueuedListener | None = None,
) -> None:
    worker_logger = logger.bind(worker_id=worker_id)
    recovery_task = asyncio.create_task(
        _recovery_loop(
            session_factory=session_factory,
            interval_seconds=recovery_interval_seconds,
            stop_event=stop_event,
        )
    )
    semaphore = asyncio.Semaphore(settings.worker_max_inflight_runs)
    inflight: set[asyncio.Task[None]] = set()

    async def _execute_and_log(run_id: int) -> None:
        try:
            await execute_run(
                session_factory=session_factory,
                run_id=run_id,
                worker_id=worker_id,
                settings=settings,
                resolve_provider=resolve_provider,
            )
        except Exception:
            worker_logger.bind(run_id=run_id).exception(
                "Executor crashed; recovery loop will handle expired lease"
            )

    def _on_task_done(task: asyncio.Task[None]) -> None:
        inflight.discard(task)
        semaphore.release()

    try:
        while not stop_event.is_set():
            await semaphore.acquire()
            if stop_event.is_set():
                semaphore.release()
                break

            try:
                async with session_factory() as session:
                    claimed_run_id = await claim_next_queued_run(
                        session,
                        worker_id=worker_id,
                        lease_seconds=settings.run_lease_seconds,
                    )
                    await session.commit()
            except Exception:
                worker_logger.exception("Claim failed")
                semaphore.release()
                await _wait_for_signal_or_stop(
                    notify_listener,
                    settings.worker_poll_interval_seconds,
                    stop_event,
                )
                continue

            if claimed_run_id is None:
                semaphore.release()
                await _wait_for_signal_or_stop(
                    notify_listener,
                    settings.worker_poll_interval_seconds,
                    stop_event,
                )
                continue

            task = asyncio.create_task(_execute_and_log(claimed_run_id))
            inflight.add(task)
            task.add_done_callback(_on_task_done)
    finally:
        if inflight:
            worker_logger.bind(inflight=len(inflight)).info(
                "Draining inflight runs before shutdown"
            )
            await asyncio.gather(*inflight, return_exceptions=True)
        recovery_task.cancel()
        try:
            await recovery_task
        except asyncio.CancelledError:
            pass


async def _recovery_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    interval_seconds: float,
    stop_event: asyncio.Event,
) -> None:
    while not stop_event.is_set():
        try:
            async with session_factory() as session:
                recovered_ids = await recover_expired_runs(session)
                await session.commit()
            for run_id in recovered_ids:
                logger.bind(run_id=run_id).warning("Recovered lease-expired run")
        except Exception:
            logger.exception("Recovery loop iteration failed")
        await _sleep_or_stop(interval_seconds, stop_event)


async def _sleep_or_stop(seconds: float, stop_event: asyncio.Event) -> None:
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except TimeoutError:
        return


async def _wait_for_signal_or_stop(
    listener: RunQueuedListener | None,
    seconds: float,
    stop_event: asyncio.Event,
) -> None:
    """Wait until NOTIFY arrives, stop is requested, or fallback timeout elapses."""
    if listener is None:
        await _sleep_or_stop(seconds, stop_event)
        return

    stop_task = asyncio.create_task(stop_event.wait())
    notify_task = asyncio.create_task(listener.wait_for_notify())
    try:
        await asyncio.wait(
            {stop_task, notify_task},
            return_when=asyncio.FIRST_COMPLETED,
            timeout=seconds,
        )
    finally:
        for task in (stop_task, notify_task):
            if not task.done():
                task.cancel()
        for task in (stop_task, notify_task):
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def run_worker_from_settings() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    factory = get_session_factory()
    worker_id = build_worker_id()
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        import signal as _signal

        sig = getattr(_signal, signame, None)
        if sig is not None:
            loop.add_signal_handler(sig, stop_event.set)

    logger.bind(worker_id=worker_id).info("Worker starting")
    listener = RunQueuedListener(settings.database_url)
    try:
        await listener.start()
    except Exception:
        logger.exception(
            "RunQueuedListener failed to start; falling back to polling-only mode"
        )
        listener_for_loop: RunQueuedListener | None = None
    else:
        listener_for_loop = listener

    try:
        await run_worker_loop(
            session_factory=factory,
            settings=settings,
            worker_id=worker_id,
            resolve_provider=default_resolve_provider,
            stop_event=stop_event,
            notify_listener=listener_for_loop,
        )
    finally:
        if listener_for_loop is not None:
            await listener_for_loop.stop()
    logger.bind(worker_id=worker_id).info("Worker stopped")
