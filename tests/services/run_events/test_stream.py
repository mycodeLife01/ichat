from datetime import UTC, datetime

from fakeredis.aioredis import FakeRedis

from app.services.run_events.stream import RedisRunEventStream
from app.services.runs.events import RunEvent


async def test_redis_run_event_stream_replays_events_after_seq_and_sets_ttl() -> None:
    redis = FakeRedis(decode_responses=True)
    stream = RedisRunEventStream(
        redis=redis,
        maxlen=2048,
        ttl_seconds=600,
        orphan_ttl_seconds=86_400,
    )
    created_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)

    await stream.append(
        42,
        RunEvent(seq=1, type="run_started", payload={}),
        created_at=created_at,
    )
    await stream.append(
        42,
        RunEvent(seq=2, type="text_delta", payload={"text": "Hello"}),
        created_at=created_at,
    )

    replay = await stream.list_after(42, after_seq=1)

    assert [(event.seq, event.type, event.payload) for event in replay] == [
        (2, "text_delta", {"text": "Hello"})
    ]
    assert await redis.ttl("run:42:events") > 86_390


async def test_redis_run_event_stream_restores_orphan_ttl_after_key_loss() -> None:
    redis = FakeRedis(decode_responses=True)
    stream = RedisRunEventStream(
        redis=redis,
        maxlen=2048,
        ttl_seconds=600,
        orphan_ttl_seconds=86_400,
    )

    await stream.append(9, RunEvent(seq=1, type="run_started", payload={}))
    await redis.delete("run:9:events")
    await stream.append(9, RunEvent(seq=2, type="text_delta", payload={"text": "x"}))

    assert await redis.ttl("run:9:events") > 86_390


async def test_redis_run_event_stream_terminal_event_shortens_ttl() -> None:
    redis = FakeRedis(decode_responses=True)
    stream = RedisRunEventStream(
        redis=redis,
        maxlen=2048,
        ttl_seconds=600,
        orphan_ttl_seconds=86_400,
    )

    await stream.append(7, RunEvent(seq=1, type="run_started", payload={}))
    await stream.append(
        7,
        RunEvent(seq=2, type="run_succeeded", payload={}),
        terminal=True,
    )

    ttl = await redis.ttl("run:7:events")
    assert 590 <= ttl <= 600
