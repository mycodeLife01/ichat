"""Unit tests for the in-memory parts of RunEventSubscriptionManager.

The PG LISTEN connection is not exercised here (would need a live Postgres);
these tests inject the on-notify callback directly to verify subscribe/
unsubscribe semantics, payload handling, and fan-out behavior.
"""

import asyncio

from app.services.run_events.subscription import RunEventSubscriptionManager

DUMMY_URL = "postgresql+asyncpg://user:pass@localhost:5432/db"


async def test_subscribe_then_notify_sets_event() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    event = manager.subscribe(42)
    assert not event.is_set()
    manager._on_notify(None, 0, "run_events", "42")
    assert event.is_set()


async def test_unsubscribe_stops_receiving_notifies() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    event = manager.subscribe(42)
    manager.unsubscribe(42, event)
    manager._on_notify(None, 0, "run_events", "42")
    assert not event.is_set()


async def test_multiple_subscribers_on_same_run_all_woken() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    e1 = manager.subscribe(42)
    e2 = manager.subscribe(42)
    manager._on_notify(None, 0, "run_events", "42")
    assert e1.is_set()
    assert e2.is_set()


async def test_notify_for_unrelated_run_does_not_wake() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    event = manager.subscribe(42)
    manager._on_notify(None, 0, "run_events", "99")
    assert not event.is_set()


async def test_invalid_payload_is_ignored() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    event = manager.subscribe(42)
    manager._on_notify(None, 0, "run_events", "not_an_int")
    assert not event.is_set()


async def test_unsubscribe_unknown_event_is_safe() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    stray = asyncio.Event()
    # Should not raise even though stray was never subscribed
    manager.unsubscribe(42, stray)


async def test_subscriber_set_is_cleared_when_last_unsubscribes() -> None:
    manager = RunEventSubscriptionManager(DUMMY_URL)
    event = manager.subscribe(42)
    manager.unsubscribe(42, event)
    assert 42 not in manager._subscribers
