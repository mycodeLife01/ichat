import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.run import Run, RunEvent
from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderMessage,
    ReasoningDelta,
    TextDelta,
)
from app.services.runs.lifecycle import claim_next_queued_run
from app.worker.executor import execute_run
from tests.providers.fake import FakeProvider, Sleep
from tests.worker.test_executor import (
    SummarizeMixin,
    clean_test_data,
    make_resolver,
    queue_run,
)

TEST_DATABASE_URL = os.environ.get(
    "WORKER_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)


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


@pytest.fixture()
def settings() -> Settings:
    return get_settings()


async def _setup_claimed_run(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings
) -> int:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()
    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()
    return run_id


async def _fetch_text_deltas(
    session_factory: async_sessionmaker[AsyncSession], run_id: int
) -> list[str]:
    async with session_factory() as session:
        events = (
            await session.scalars(
                select(RunEvent)
                .where(RunEvent.run_id == run_id, RunEvent.type == "text_delta")
                .order_by(RunEvent.seq.asc())
            )
        ).all()
    return [e.payload["text"] for e in events]


async def test_back_to_back_small_deltas_merge_into_single_event(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """Multiple sub-window deltas yielded back-to-back coalesce into one DB row."""
    run_id = await _setup_claimed_run(session_factory, settings)
    fake = FakeProvider(
        script=[
            TextDelta(text="a"),
            TextDelta(text="b"),
            TextDelta(text="c"),
            TextDelta(text="d"),
            Finish(finish_reason="stop"),
        ]
    )
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    deltas = await _fetch_text_deltas(session_factory, run_id)
    assert deltas == ["abcd"]


async def test_char_threshold_flush_splits_long_run(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """When pending crosses 256 chars between yields, a flush fires immediately."""
    chunk_text = "x" * 100
    fake = FakeProvider(
        script=[
            TextDelta(text=chunk_text),
            TextDelta(text=chunk_text),
            TextDelta(text=chunk_text),  # accumulated 300 chars triggers flush
            TextDelta(text="tail"),
            Finish(finish_reason="stop"),
        ]
    )
    run_id = await _setup_claimed_run(session_factory, settings)
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    deltas = await _fetch_text_deltas(session_factory, run_id)
    assert len(deltas) == 2
    assert deltas[0] == chunk_text * 3
    assert deltas[1] == "tail"


async def test_time_window_flushes_idle_pending_text(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """Sleep between deltas longer than batch window forces flush before next chunk."""
    fake = FakeProvider(
        script=[
            TextDelta(text="first"),
            Sleep(seconds=0.2),  # > 50ms window forces flush of 'first'
            TextDelta(text="second"),
            Finish(finish_reason="stop"),
        ]
    )
    run_id = await _setup_claimed_run(session_factory, settings)
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    deltas = await _fetch_text_deltas(session_factory, run_id)
    assert deltas == ["first", "second"]


async def test_provider_error_flushes_pending_before_failing(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """A ProviderError mid-stream still persists buffered text before recording failure."""
    call_count = {"n": 0}

    class FailingAfterDelta(SummarizeMixin, Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            call_count["n"] += 1
            from app.providers import ProviderError

            yield TextDelta(text="buffered")
            raise ProviderError(code="upstream_5xx", message="boom")

    run_id = await _setup_claimed_run(session_factory, settings)
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(FailingAfterDelta()),
    )

    assert call_count["n"] == 1  # no retry because delta persisted

    deltas = await _fetch_text_deltas(session_factory, run_id)
    assert deltas == ["buffered"]
    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "upstream_5xx"


async def _fetch_event_types(
    session_factory: async_sessionmaker[AsyncSession], run_id: int
) -> list[tuple[str, str]]:
    async with session_factory() as session:
        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
    return [(e.type, e.payload.get("text", "")) for e in events]


async def test_reasoning_then_text_persist_as_separate_ordered_events(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    run_id = await _setup_claimed_run(session_factory, settings)
    fake = FakeProvider(
        script=[
            ReasoningDelta(text="th"),
            ReasoningDelta(text="ink"),
            TextDelta(text="ans"),
            TextDelta(text="wer"),
            Finish(finish_reason="stop"),
        ]
    )
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    typed = await _fetch_event_types(session_factory, run_id)
    assert typed == [
        ("run_started", ""),
        ("reasoning_delta", "think"),
        ("text_delta", "answer"),
        ("run_succeeded", ""),
    ]


async def test_reasoning_only_then_error_does_not_retry(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """Once reasoning has flushed (run is streaming), a failure must not retry."""
    call_count = {"n": 0}

    class ReasoningThenError(SummarizeMixin, Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            from app.providers import ProviderError

            call_count["n"] += 1
            yield ReasoningDelta(text="thinking hard")
            raise ProviderError(code="upstream_5xx", message="boom")

    run_id = await _setup_claimed_run(session_factory, settings)
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(ReasoningThenError()),
    )

    assert call_count["n"] == 1  # no retry: reasoning flush already marked run streaming
    typed = await _fetch_event_types(session_factory, run_id)
    assert ("reasoning_delta", "thinking hard") in typed
    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
