import asyncio

from fakeredis.aioredis import FakeRedis

from app.services.runs.wakeup import RedisRunCancelPublisher
from app.worker.run_cancel_listener import RunCancelListener


async def test_cancel_listener_sets_registered_run_event() -> None:
    redis = FakeRedis(decode_responses=True)
    listener = RunCancelListener(redis=redis)
    publisher = RedisRunCancelPublisher(redis=redis)
    cancel = asyncio.Event()
    listener.register(7, cancel)
    await listener.start()

    try:
        await publisher.publish(7)
        await asyncio.wait_for(cancel.wait(), timeout=1.0)
    finally:
        await listener.stop()

    assert cancel.is_set()


async def test_cancel_listener_ignores_unregistered_run() -> None:
    redis = FakeRedis(decode_responses=True)
    listener = RunCancelListener(redis=redis)
    publisher = RedisRunCancelPublisher(redis=redis)
    registered = asyncio.Event()
    listener.register(1, registered)
    await listener.start()

    try:
        await publisher.publish(999)
        await publisher.publish(1)
        await asyncio.wait_for(registered.wait(), timeout=1.0)
    finally:
        await listener.stop()

    assert registered.is_set()


async def test_cancel_listener_drops_signal_after_unregister() -> None:
    redis = FakeRedis(decode_responses=True)
    listener = RunCancelListener(redis=redis)
    publisher = RedisRunCancelPublisher(redis=redis)
    cancel = asyncio.Event()
    listener.register(5, cancel)
    listener.unregister(5)
    await listener.start()

    try:
        await publisher.publish(5)
        await asyncio.sleep(0.1)
    finally:
        await listener.stop()

    assert not cancel.is_set()
