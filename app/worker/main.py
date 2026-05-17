import asyncio
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
) -> None:
    worker_logger = logger.bind(worker_id=worker_id)
    recovery_task = asyncio.create_task(
        _recovery_loop(
            session_factory=session_factory,
            interval_seconds=recovery_interval_seconds,
            stop_event=stop_event,
        )
    )
    try:
        while not stop_event.is_set():
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
                await _sleep_or_stop(settings.worker_poll_interval_seconds, stop_event)
                continue

            if claimed_run_id is None:
                await _sleep_or_stop(settings.worker_poll_interval_seconds, stop_event)
                continue

            try:
                await execute_run(
                    session_factory=session_factory,
                    run_id=claimed_run_id,
                    worker_id=worker_id,
                    settings=settings,
                    resolve_provider=resolve_provider,
                )
            except Exception:
                worker_logger.bind(run_id=claimed_run_id).exception(
                    "Executor crashed; recovery loop will handle expired lease"
                )
    finally:
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
    await run_worker_loop(
        session_factory=factory,
        settings=settings,
        worker_id=worker_id,
        resolve_provider=default_resolve_provider,
        stop_event=stop_event,
    )
    logger.bind(worker_id=worker_id).info("Worker stopped")
