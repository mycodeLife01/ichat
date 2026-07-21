import asyncio
import os
from collections.abc import AsyncIterator

import pytest
from fakeredis.aioredis import FakeRedis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.run import Run, RunDraft
from app.models.run import RunEvent as RunEventRow
from app.services.run_events.stream import RedisRunEventStream
from app.services.runs.events import RunEvent
from app.services.runs.lifecycle import claim_next_queued_run
from app.worker.event_sink import (
    DraftCheckpointSink,
    FanoutSink,
    PostgresEventSink,
    RedisStreamSink,
)
from tests.worker.test_executor import clean_test_data, queue_run

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


async def test_fanout_streams_every_chunk_but_postgres_keeps_only_semantic_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()
    async with session_factory() as session:
        await claim_next_queued_run(session, worker_id="worker-x", lease_seconds=60)
        await session.commit()

    redis = FakeRedis(decode_responses=True)
    stream = RedisRunEventStream(
        redis=redis,
        maxlen=2048,
        ttl_seconds=600,
        orphan_ttl_seconds=86_400,
    )
    cancel = asyncio.Event()
    draft_sink = DraftCheckpointSink(
        session_factory=session_factory,
        run_id=run_id,
        cancel=cancel,
        interval_seconds=3,
        max_pending_chars=4096,
    )
    sink = FanoutSink(
        RedisStreamSink(stream=stream, run_id=run_id),
        PostgresEventSink(
            session_factory=session_factory,
            run_id=run_id,
            cancel=cancel,
        ),
        draft_sink,
    )

    await sink.emit(RunEvent(seq=2, type="text_delta", payload={"text": "Hel"}))
    await sink.emit(RunEvent(seq=3, type="text_delta", payload={"text": "lo"}))
    await sink.emit(
        RunEvent(
            seq=4,
            type="tool_call_started",
            payload={"tool_name": "web_search", "query": "news", "provider": "tavily"},
        )
    )
    await sink.flush()

    replay = await stream.list_after(run_id, after_seq=1)
    assert [(event.seq, event.type) for event in replay] == [
        (2, "text_delta"),
        (3, "text_delta"),
        (4, "tool_call_started"),
    ]

    async with session_factory() as session:
        rows = (
            await session.scalars(
                select(RunEventRow)
                .where(RunEventRow.run_id == run_id)
                .order_by(RunEventRow.seq.asc())
            )
        ).all()
        assert [row.type for row in rows] == ["run_started", "tool_call_started"]
        draft = await session.get(RunDraft, run_id)
        assert draft is not None
        assert (draft.seq, draft.text, draft.reasoning) == (3, "Hello", "")
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "streaming"

    await draft_sink.delete()
    async with session_factory() as session:
        assert await session.get(RunDraft, run_id) is None


async def test_draft_checkpoint_flushes_at_pending_char_limit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()
    sink = DraftCheckpointSink(
        session_factory=session_factory,
        run_id=run_id,
        cancel=asyncio.Event(),
        interval_seconds=60,
        max_pending_chars=3,
    )

    await sink.emit(RunEvent(seq=1, type="text_delta", payload={"text": "abc"}))

    async with session_factory() as session:
        draft = await session.get(RunDraft, run_id)
        assert draft is not None
        assert (draft.seq, draft.text) == (1, "abc")


async def test_draft_checkpoint_flushes_after_interval(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()
    sink = DraftCheckpointSink(
        session_factory=session_factory,
        run_id=run_id,
        cancel=asyncio.Event(),
        interval_seconds=0.01,
        max_pending_chars=4096,
    )

    await sink.emit(RunEvent(seq=1, type="reasoning_delta", payload={"text": "think"}))
    await asyncio.sleep(0.05)

    async with session_factory() as session:
        draft = await session.get(RunDraft, run_id)
        assert draft is not None
        assert (draft.seq, draft.reasoning) == (1, "think")


async def test_redis_stream_sink_drops_redis_failure_without_raising() -> None:
    class FailingStream:
        async def append(self, run_id: int, event: RunEvent) -> None:
            raise TimeoutError("redis unavailable")

    sink = RedisStreamSink(stream=FailingStream(), run_id=1)

    await sink.emit(RunEvent(seq=1, type="text_delta", payload={"text": "x"}))
