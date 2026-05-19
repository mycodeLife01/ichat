import asyncio
import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.run import Run
from app.providers import Finish, Provider, ProviderChunk, ProviderMessage, TextDelta
from app.worker.main import run_worker_loop
from tests.worker.test_main import clean_test_data, make_queued_run

TEST_DATABASE_URL = os.environ.get(
    "WORKER_MAIN_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)


class SummarizeMixin:
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        return "Fake Title"


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def test_worker_loop_runs_multiple_runs_concurrently(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Three runs whose providers each block 0.5s should finish in ~0.5s total,
    not ~1.5s (serial). The semaphore default of 8 lets all 3 run in parallel."""
    async with session_factory() as session:
        run_ids = [await make_queued_run(session) for _ in range(3)]
        await session.commit()

    settings = get_settings().model_copy(
        update={
            "worker_poll_interval_seconds": 0.05,
            "worker_heartbeat_interval_seconds": 0.05,
            "run_lease_seconds": 30,
            "worker_max_inflight_runs": 8,
        }
    )

    class SlowProvider(SummarizeMixin, Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            yield TextDelta(text="working")
            await asyncio.sleep(0.5)
            yield Finish(finish_reason="stop")

    def resolve(name: str, *, settings: Settings) -> Provider:
        return SlowProvider()

    stop_event = asyncio.Event()

    async def watch_all_done() -> None:
        for _ in range(80):  # up to 8s
            await asyncio.sleep(0.1)
            async with session_factory() as session:
                statuses = []
                for rid in run_ids:
                    run = await session.get(Run, rid)
                    statuses.append(run.status if run else None)
                if all(s == "succeeded" for s in statuses):
                    stop_event.set()
                    return
        stop_event.set()

    loop_start = asyncio.get_running_loop().time()
    watch_task = asyncio.create_task(watch_all_done())
    worker_task = asyncio.create_task(
        run_worker_loop(
            session_factory=session_factory,
            settings=settings,
            worker_id="worker-concurrency-test",
            resolve_provider=resolve,
            stop_event=stop_event,
            recovery_interval_seconds=1.0,
        )
    )
    try:
        await asyncio.wait_for(worker_task, timeout=10.0)
    finally:
        watch_task.cancel()

    elapsed = asyncio.get_running_loop().time() - loop_start

    async with session_factory() as session:
        for rid in run_ids:
            run = await session.get(Run, rid)
            assert run is not None
            assert run.status == "succeeded"

    # Serial would take >= 3 * 0.5s = 1.5s; concurrent runs all finish within ~1.0s
    assert elapsed < 1.5, f"Expected concurrent execution, took {elapsed:.2f}s"


async def test_worker_loop_respects_max_inflight_cap(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """With cap=1, three runs are processed serially — total >= 3 * 0.3s."""
    async with session_factory() as session:
        run_ids = [await make_queued_run(session) for _ in range(3)]
        await session.commit()

    settings = get_settings().model_copy(
        update={
            "worker_poll_interval_seconds": 0.05,
            "worker_heartbeat_interval_seconds": 0.05,
            "run_lease_seconds": 30,
            "worker_max_inflight_runs": 1,
        }
    )

    class SlowProvider(SummarizeMixin, Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            yield TextDelta(text="working")
            await asyncio.sleep(0.3)
            yield Finish(finish_reason="stop")

    def resolve(name: str, *, settings: Settings) -> Provider:
        return SlowProvider()

    stop_event = asyncio.Event()

    async def watch_all_done() -> None:
        for _ in range(80):
            await asyncio.sleep(0.1)
            async with session_factory() as session:
                statuses = []
                for rid in run_ids:
                    run = await session.get(Run, rid)
                    statuses.append(run.status if run else None)
                if all(s == "succeeded" for s in statuses):
                    stop_event.set()
                    return
        stop_event.set()

    loop_start = asyncio.get_running_loop().time()
    watch_task = asyncio.create_task(watch_all_done())
    worker_task = asyncio.create_task(
        run_worker_loop(
            session_factory=session_factory,
            settings=settings,
            worker_id="worker-cap-test",
            resolve_provider=resolve,
            stop_event=stop_event,
            recovery_interval_seconds=1.0,
        )
    )
    try:
        await asyncio.wait_for(worker_task, timeout=10.0)
    finally:
        watch_task.cancel()

    elapsed = asyncio.get_running_loop().time() - loop_start
    # Serial execution: ~0.9s. Concurrent would be ~0.3s.
    assert elapsed >= 0.8, f"Expected serial execution with cap=1, took {elapsed:.2f}s"
