import asyncio
import contextlib
import time
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.context import build_context
from app.core.config import Settings
from app.core.logging import logger
from app.models.run import Run
from app.providers import (
    Finish,
    Provider,
    ProviderError,
    ProviderMessage,
    ReasoningDelta,
    TextDelta,
)
from app.services.conversations import materialize_assistant_message
from app.services.runs.lifecycle import (
    is_cancelling,
    mark_run_cancelled,
    mark_run_cancelled_if_cancelling,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    renew_lease,
    run_has_text_delta,
)
from app.services.runs.service import append_run_event
from app.worker.title import maybe_generate_title

_STREAM_DONE = object()  # sentinel posted on the provider-stream queue


class ProviderResolver(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider: ...


async def execute_run(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> None:
    run_logger = logger.bind(run_id=run_id, worker_id=worker_id)

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            run_logger.warning("Run vanished before execution")
            return
        provider_name = run.provider_name
        provider_model = run.provider_model
        provider = resolve_provider(provider_name, settings=settings)
        try:
            messages = await build_context(
                session,
                run_id=run_id,
                system_prompt=settings.default_system_prompt,
                budget_tokens=settings.context_budget_tokens,
                count_tokens=provider.count_tokens,
            )
        except Exception as exc:
            run_logger.exception("Context build failed")
            await session.rollback()
            await _mark_failed_or_cancelled_if_cancelling(
                session_factory,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
            )
            return
        await session.commit()

    cancel_event = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(
            session_factory=session_factory,
            run_id=run_id,
            lease_seconds=settings.run_lease_seconds,
            interval_seconds=settings.worker_heartbeat_interval_seconds,
            cancel_event=cancel_event,
        )
    )

    try:
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            outcome = await _run_provider_stream_until_done_or_cancelled(
                session_factory=session_factory,
                run_id=run_id,
                provider=provider,
                provider_model=provider_model,
                messages=messages,
                cancel_event=cancel_event,
                batch_window_seconds=settings.worker_delta_batch_window_ms / 1000.0,
                batch_max_chars=settings.worker_delta_batch_max_chars,
                settings=settings,
                resolve_provider=resolve_provider,
            )
            if outcome.status == "succeeded":
                return
            if outcome.status == "cancelled":
                async with session_factory() as session:
                    await mark_run_cancelled(session, run_id=run_id)
                    await session.commit()
                return
            if await _cancel_if_db_status_is_cancelling(
                session_factory,
                run_id=run_id,
            ):
                return
            allow_retry = (
                outcome.before_first_delta
                and attempt < max_attempts
                and not outcome.delta_persisted
                and not cancel_event.is_set()
            )
            if allow_retry:
                run_logger.bind(code=outcome.code).info("Retrying provider stream once")
                continue
            if cancel_event.is_set():
                async with session_factory() as session:
                    await mark_run_cancelled(session, run_id=run_id)
                    await session.commit()
                return
            await _mark_failed_or_cancelled_if_cancelling(
                session_factory,
                run_id=run_id,
                code=outcome.code or "unknown_error",
                message=outcome.message or "",
            )
            return
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def _heartbeat_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    lease_seconds: int,
    interval_seconds: float,
    cancel_event: asyncio.Event,
) -> None:
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            async with session_factory() as session:
                await renew_lease(session, run_id=run_id, lease_seconds=lease_seconds)
                cancelling = await is_cancelling(session, run_id=run_id)
                await session.commit()
            if cancelling:
                cancel_event.set()
        except asyncio.CancelledError:
            return


async def _cancel_if_db_status_is_cancelling(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    run_id: int,
) -> bool:
    async with session_factory() as session:
        changed = await mark_run_cancelled_if_cancelling(session, run_id=run_id)
        await session.commit()
        return changed


async def _mark_failed_or_cancelled_if_cancelling(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    run_id: int,
    code: str,
    message: str,
) -> None:
    async with session_factory() as session:
        cancelled = await mark_run_cancelled_if_cancelling(session, run_id=run_id)
        if not cancelled:
            await mark_run_failed(
                session,
                run_id=run_id,
                code=code,
                message=message,
            )
        await session.commit()


@dataclass
class _StreamOutcome:
    status: str  # "succeeded" | "failed" | "cancelled"
    before_first_delta: bool
    delta_persisted: bool
    code: str | None = None
    message: str | None = None


async def _run_provider_stream_until_done_or_cancelled(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    cancel_event: asyncio.Event,
    batch_window_seconds: float,
    batch_max_chars: int,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> _StreamOutcome:
    stream_task = asyncio.create_task(
        _run_provider_stream(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            provider_model=provider_model,
            messages=messages,
            cancel_event=cancel_event,
            batch_window_seconds=batch_window_seconds,
            batch_max_chars=batch_max_chars,
            settings=settings,
            resolve_provider=resolve_provider,
        )
    )
    cancel_task = asyncio.create_task(cancel_event.wait())
    try:
        done, _ = await asyncio.wait(
            {stream_task, cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancel_task in done and cancel_event.is_set() and not stream_task.done():
            stream_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stream_task
            async with session_factory() as session:
                delta_persisted = await run_has_text_delta(session, run_id=run_id)
            return _StreamOutcome(
                status="cancelled",
                before_first_delta=not delta_persisted,
                delta_persisted=delta_persisted,
            )
        return await stream_task
    finally:
        for task in (stream_task, cancel_task):
            if not task.done():
                task.cancel()
        for task in (stream_task, cancel_task):
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def _run_provider_stream(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    cancel_event: asyncio.Event,
    batch_window_seconds: float,
    batch_max_chars: int,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> _StreamOutcome:
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    pending: list[str] = []
    pending_chars = 0
    pending_channel: str | None = None  # "text" | "reasoning"
    first_flush_done = False
    window_started_at = 0.0

    async def flush_pending() -> bool:
        nonlocal pending_chars, first_flush_done, pending_channel
        if not pending:
            return True
        text = "".join(pending)
        async with session_factory() as session:
            if not first_flush_done:
                changed = await mark_run_streaming(session, run_id=run_id)
                if not changed:
                    await session.commit()
                    return False
                first_flush_done = True
            # Pass the event type as a literal (not a variable) so it satisfies the
            # RunEventType Literal accepted by append_run_event under mypy.
            if pending_channel == "reasoning":
                await append_run_event(
                    session, run_id=run_id, event_type="reasoning_delta", payload={"text": text}
                )
            else:
                await append_run_event(
                    session, run_id=run_id, event_type="text_delta", payload={"text": text}
                )
            await session.commit()
        pending.clear()
        pending_chars = 0
        pending_channel = None
        return True

    # Drive the provider stream from a background producer task so that the
    # main loop can flush on a time window without cancelling the stream's
    # coroutine. (asyncio.wait_for around stream.__anext__() would cancel the
    # underlying task on timeout, poisoning the generator and dropping any
    # remaining chunks.) The producer forwards chunks into an asyncio.Queue;
    # a ProviderError is forwarded as an item, then _STREAM_DONE terminates.
    queue: asyncio.Queue[object] = asyncio.Queue()

    async def _producer() -> None:
        try:
            async for produced in provider.stream(
                model=provider_model, messages=messages
            ):
                await queue.put(produced)
        except ProviderError as exc:
            await queue.put(exc)
        finally:
            await queue.put(_STREAM_DONE)

    producer_task = asyncio.create_task(_producer())

    try:
        while True:
            if pending:
                elapsed = time.monotonic() - window_started_at
                timeout: float | None = max(batch_window_seconds - elapsed, 0.0)
            else:
                timeout = None

            try:
                if timeout is None:
                    item = await queue.get()
                else:
                    item = await asyncio.wait_for(queue.get(), timeout=timeout)
            except TimeoutError:
                if not await flush_pending():
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
                continue

            if item is _STREAM_DONE:
                break

            if isinstance(item, ProviderError):
                if pending:
                    with contextlib.suppress(Exception):
                        await flush_pending()
                async with session_factory() as session:
                    delta_persisted = await run_has_text_delta(session, run_id=run_id)
                return _StreamOutcome(
                    status="failed",
                    before_first_delta=not first_flush_done,
                    delta_persisted=delta_persisted,
                    code=item.code,
                    message=item.message,
                )

            chunk = item

            if cancel_event.is_set():
                if pending:
                    await flush_pending()
                return _StreamOutcome(
                    status="cancelled",
                    before_first_delta=not first_flush_done,
                    delta_persisted=first_flush_done,
                )

            if isinstance(chunk, (TextDelta, ReasoningDelta)):
                channel = "reasoning" if isinstance(chunk, ReasoningDelta) else "text"
                # Channel switch: flush the previous channel before buffering the new one,
                # so reasoning_delta events strictly precede text_delta events in seq order.
                if pending and pending_channel != channel:
                    if not await flush_pending():
                        return _StreamOutcome(
                            status="cancelled",
                            before_first_delta=not first_flush_done,
                            delta_persisted=first_flush_done,
                        )
                if not pending:
                    window_started_at = time.monotonic()
                    pending_channel = channel
                if channel == "reasoning":
                    reasoning_parts.append(chunk.text)
                else:
                    text_parts.append(chunk.text)
                pending.append(chunk.text)
                pending_chars += len(chunk.text)
                if pending_chars >= batch_max_chars:
                    if not await flush_pending():
                        return _StreamOutcome(
                            status="cancelled",
                            before_first_delta=True,
                            delta_persisted=False,
                        )
                if cancel_event.is_set():
                    if pending:
                        await flush_pending()
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
            elif isinstance(chunk, Finish):
                if pending and not await flush_pending():
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
                full_text = "".join(text_parts)
                full_reasoning = "".join(reasoning_parts)
                async with session_factory() as session:
                    changed = await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    if changed:
                        await materialize_assistant_message(
                            session,
                            run_id=run_id,
                            content=full_text,
                            reasoning=full_reasoning or None,
                        )
                    await session.commit()
                if not changed:
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
                await maybe_generate_title(
                    session_factory=session_factory,
                    run_id=run_id,
                    settings=settings,
                    resolve_provider=resolve_provider,
                )
                return _StreamOutcome(
                    status="succeeded",
                    before_first_delta=not first_flush_done,
                    delta_persisted=first_flush_done,
                )
    finally:
        if not producer_task.done():
            producer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await producer_task

    # Stream ended without Finish
    if pending:
        with contextlib.suppress(Exception):
            await flush_pending()
    async with session_factory() as session:
        delta_persisted = await run_has_text_delta(session, run_id=run_id)
    return _StreamOutcome(
        status="failed",
        before_first_delta=not first_flush_done,
        delta_persisted=delta_persisted,
        code="no_finish",
        message="Provider stream ended without finish chunk",
    )
