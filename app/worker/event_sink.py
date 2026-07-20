import asyncio
import contextlib
from collections.abc import Mapping
from typing import Any, Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.runs.events import RunEvent, RunEventType
from app.services.runs.lifecycle import mark_run_streaming
from app.services.runs.service import append_run_event

_DELTA_TYPES = ("text_delta", "reasoning_delta")


class EventSink(Protocol):
    """Sink the worker emits assembled run events into. The worker is its only
    caller; ``PostgresEventSink`` its only implementation (a Redis Stream sink
    lands in issue 06)."""

    async def emit(self, event: RunEvent) -> None: ...


class PostgresEventSink(EventSink):
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        run_id: int,
        cancel: asyncio.Event,
        batch_window_seconds: float,
        batch_max_chars: int,
        tool_backend_names: Mapping[str, str] | None = None,
    ) -> None:
        if batch_window_seconds < 0:
            raise ValueError("batch_window_seconds must be non-negative")
        if batch_max_chars < 1:
            raise ValueError("batch_max_chars must be at least 1")
        self._session_factory = session_factory
        self._run_id = run_id
        self._cancel = cancel
        self._batch_window_seconds = batch_window_seconds
        self._batch_max_chars = batch_max_chars
        self._tool_backend_names = dict(tool_backend_names or {})
        self._lock = asyncio.Lock()
        self._streaming_started = False
        self._pending_type: RunEventType | None = None
        self._pending_parts: list[str] = []
        self._pending_chars = 0
        self._pending_seq = 0
        self._timer_task: asyncio.Task[None] | None = None
        self._background_error: Exception | None = None

    async def emit(self, event: RunEvent) -> None:
        self._raise_background_error()
        async with self._lock:
            self._raise_background_error()
            if event.type in _DELTA_TYPES:
                await self._buffer_delta(event)
                return
            self._cancel_timer()
            await self._flush_pending()
            await self._persist(event)

    async def flush(self) -> None:
        self._raise_background_error()
        async with self._lock:
            self._raise_background_error()
            self._cancel_timer()
            await self._flush_pending()
        self._raise_background_error()

    async def _buffer_delta(self, event: RunEvent) -> None:
        text = event.payload.get("text")
        if not isinstance(text, str) or not text:
            return
        if self._pending_parts and self._pending_type != event.type:
            self._cancel_timer()
            await self._flush_pending()
        if not self._pending_parts:
            self._pending_type = event.type
            self._start_timer()
        self._pending_parts.append(text)
        self._pending_chars += len(text)
        self._pending_seq = event.seq
        if (
            self._batch_window_seconds == 0
            or self._pending_chars >= self._batch_max_chars
        ):
            self._cancel_timer()
            await self._flush_pending()

    def _start_timer(self) -> None:
        if self._batch_window_seconds == 0:
            return
        self._timer_task = asyncio.create_task(self._flush_after_window())

    async def _flush_after_window(self) -> None:
        try:
            await asyncio.sleep(self._batch_window_seconds)
            async with self._lock:
                if self._timer_task is asyncio.current_task():
                    self._timer_task = None
                await self._flush_pending()
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

    async def _flush_pending(self) -> None:
        if not self._pending_parts or self._pending_type is None:
            return
        event = RunEvent(
            seq=self._pending_seq,
            type=self._pending_type,
            payload={"text": "".join(self._pending_parts)},
        )
        await self._persist(event)
        self._pending_type = None
        self._pending_parts.clear()
        self._pending_chars = 0
        self._pending_seq = 0

    async def _persist(self, event: RunEvent) -> None:
        async with self._session_factory() as session:
            starting_stream = not self._streaming_started
            if starting_stream:
                changed = await mark_run_streaming(session, run_id=self._run_id)
                if not changed:
                    await session.commit()
                    self._cancel.set()
                    return
            await append_run_event(
                session,
                run_id=self._run_id,
                event_type=event.type,
                payload=self._external_payload(event),
                seq=event.seq,
            )
            await session.commit()
            if starting_stream:
                self._streaming_started = True

    def _external_payload(self, event: RunEvent) -> dict[str, Any]:
        if event.type in _DELTA_TYPES:
            return event.payload
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
            provider = self._tool_backend_names.get(payload["tool_name"])
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

    def _raise_background_error(self) -> None:
        if self._background_error is not None:
            raise self._background_error

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
