import asyncio

from fakeredis.aioredis import FakeRedis

from app.services.runs.wakeup import RedisRunQueuedPublisher
from app.worker.run_queued_listener import RunQueuedListener


async def test_redis_run_queued_listener_wakes_on_publish() -> None:
    redis = FakeRedis(decode_responses=True)
    listener = RunQueuedListener(redis=redis)
    publisher = RedisRunQueuedPublisher(redis=redis)
    await listener.start()

    try:
        wait_task = asyncio.create_task(listener.wait_for_notify())
        await publisher.publish(42)
        await asyncio.wait_for(wait_task, timeout=1.0)
    finally:
        await listener.stop()
