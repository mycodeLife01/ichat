import asyncio
import contextlib
from collections.abc import Mapping
from typing import Any, Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.logging import logger
from app.services.runs.drafts import delete_run_draft, upsert_run_draft
from app.services.runs.events import RunEvent
from app.services.runs.lifecycle import mark_run_streaming
from app.services.runs.service import append_run_event

_DELTA_TYPES = frozenset({"text_delta", "reasoning_delta"})
_TOOL_EVENT_TYPES = frozenset(
    {"tool_call_started", "tool_call_succeeded", "tool_call_failed"}
)


class EventSink(Protocol):
    async def emit(self, event: RunEvent) -> None: ...

    async def flush(self) -> None: ...

    async def aclose(self) -> None: ...


class RunEventStreamWriter(Protocol):
    async def append(self, run_id: int, event: RunEvent) -> None: ...


class RedisStreamSink:
    """Best-effort low-latency transport for every in-flight event."""

    def __init__(self, *, stream: RunEventStreamWriter, run_id: int) -> None:
        self._stream = stream
        self._run_id = run_id

    async def emit(self, event: RunEvent) -> None:
        try:
            await self._stream.append(self._run_id, event)
        except Exception as exc:
            logger.bind(
                run_id=self._run_id,
                seq=event.seq,
                event_type=event.type,
                error=str(exc),
            ).warning("Redis run event append failed; dropping event")

    async def flush(self) -> None:
        return

    async def aclose(self) -> None:
        return


class PostgresEventSink:
    """Persist semantic events while moving the run into streaming once."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        run_id: int,
        cancel: asyncio.Event,
    ) -> None:
        self._session_factory = session_factory
        self._run_id = run_id
        self._cancel = cancel
        self._streaming_started = False
        self._lock = asyncio.Lock()

    async def emit(self, event: RunEvent) -> None:
        if self._streaming_started and event.type in _DELTA_TYPES:
            return
        async with self._lock:
            if self._streaming_started and event.type in _DELTA_TYPES:
                return
            async with self._session_factory() as session:
                if not self._streaming_started:
                    changed = await mark_run_streaming(session, run_id=self._run_id)
                    if not changed:
                        await session.commit()
                        self._cancel.set()
                        return
                if event.type not in _DELTA_TYPES:
                    await append_run_event(
                        session,
                        run_id=self._run_id,
                        event_type=event.type,
                        payload=event.payload,
                        seq=event.seq,
                    )
                await session.commit()
                self._streaming_started = True

    async def flush(self) -> None:
        return

    async def aclose(self) -> None:
        return


class DraftCheckpointSink:
    """Persist cumulative text/reasoning snapshots at coarse intervals."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        run_id: int,
        cancel: asyncio.Event,
        interval_seconds: float,
        max_pending_chars: int,
        max_events: int = 2048,
    ) -> None:
        if interval_seconds < 0:
            raise ValueError("interval_seconds must be non-negative")
        if max_pending_chars < 1:
            raise ValueError("max_pending_chars must be at least 1")
        if max_events < 1:
            raise ValueError("max_events must be at least 1")
        self._session_factory = session_factory
        self._run_id = run_id
        self._cancel = cancel
        self._interval_seconds = interval_seconds
        self._max_pending_chars = max_pending_chars
        self._max_events = max_events
        self._lock = asyncio.Lock()
        self._text_parts: list[str] = []
        self._reasoning_parts: list[str] = []
        self._events: list[dict[str, Any]] = []
        self._latest_seq = 0
        self._pending_chars = 0
        self._dirty = False
        self._timer_task: asyncio.Task[None] | None = None
        self._background_error: Exception | None = None

    async def emit(self, event: RunEvent) -> None:
        self._raise_background_error()
        async with self._lock:
            self._raise_background_error()
            if event.type in _DELTA_TYPES:
                text = event.payload.get("text")
                if not isinstance(text, str) or not text:
                    return
                if event.type == "text_delta":
                    self._text_parts.append(text)
                else:
                    self._reasoning_parts.append(text)
                self._events.append(
                    {"seq": event.seq, "type": event.type, "payload": dict(event.payload)}
                )
                if len(self._events) > self._max_events:
                    del self._events[: len(self._events) - self._max_events]
                self._latest_seq = event.seq
                self._pending_chars += len(text)
                self._dirty = True
                if self._timer_task is None:
                    self._start_timer()
                if (
                    self._interval_seconds == 0
                    or self._pending_chars >= self._max_pending_chars
                ):
                    self._cancel_timer()
                    await self._checkpoint()
                return

            if event.type in _TOOL_EVENT_TYPES and self._dirty:
                self._cancel_timer()
                await self._checkpoint()

    async def flush(self) -> None:
        self._raise_background_error()
        async with self._lock:
            self._raise_background_error()
            self._cancel_timer()
            await self._checkpoint()
        self._raise_background_error()

    async def delete(self) -> None:
        await self.flush()
        async with self._session_factory() as session:
            await delete_run_draft(session, run_id=self._run_id)
            await session.commit()

    async def aclose(self) -> None:
        try:
            await self.flush()
        finally:
            task = self._timer_task
            self._timer_task = None
            if task is not None and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    def _start_timer(self) -> None:
        if self._interval_seconds == 0:
            return
        self._timer_task = asyncio.create_task(self._checkpoint_after_interval())

    async def _checkpoint_after_interval(self) -> None:
        try:
            await asyncio.sleep(self._interval_seconds)
            async with self._lock:
                if self._timer_task is asyncio.current_task():
                    self._timer_task = None
                await self._checkpoint()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            self._background_error = exc
            self._cancel.set()

    def _cancel_timer(self) -> None:
        task = self._timer_task
        self._timer_task = None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def _checkpoint(self) -> None:
        if not self._dirty or self._latest_seq < 1:
            return
        async with self._session_factory() as session:
            await upsert_run_draft(
                session,
                run_id=self._run_id,
                seq=self._latest_seq,
                text="".join(self._text_parts),
                reasoning="".join(self._reasoning_parts),
                events=list(self._events),
            )
            await session.commit()
        self._pending_chars = 0
        self._dirty = False

    def _raise_background_error(self) -> None:
        if self._background_error is not None:
            raise self._background_error


class FanoutSink:
    def __init__(self, *sinks: EventSink, initial_seq: int = 0) -> None:
        self._sinks = sinks
        self._latest_seq = initial_seq

    @property
    def latest_seq(self) -> int:
        return self._latest_seq

    async def emit(self, event: RunEvent) -> None:
        self._latest_seq = event.seq
        await asyncio.gather(*(sink.emit(event) for sink in self._sinks))

    async def flush(self) -> None:
        await asyncio.gather(*(sink.flush() for sink in self._sinks))

    async def aclose(self) -> None:
        await asyncio.gather(*(sink.aclose() for sink in self._sinks), return_exceptions=True)


def external_tool_payload(
    event: RunEvent,
    *,
    tool_backend_names: Mapping[str, str],
) -> dict[str, Any]:
    tool_name = event.payload.get("tool_name")
    payload: dict[str, Any] = {
        "tool_name": tool_name if isinstance(tool_name, str) else "",
    }
    if event.type == "tool_call_started":
        arguments = event.payload.get("arguments")
        if isinstance(arguments, dict):
            query = arguments.get("query")
            if isinstance(query, str):
                payload["query"] = query
        provider = tool_backend_names.get(payload["tool_name"])
        if provider is not None:
            payload["provider"] = provider
        return payload

    metadata = event.payload.get("metadata")
    if isinstance(metadata, dict):
        payload.update(metadata)
    if event.type == "tool_call_failed":
        payload.setdefault("error_code", "tool_error")
        payload.setdefault("message", "Tool execution failed.")
    return payload
