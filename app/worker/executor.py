import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent import (
    AgentFinal,
    Message,
    MessageDone,
    Provider,
    ProviderError,
    ReasoningDelta,
    TextDelta,
    ToolCallFinished,
    ToolCallStarted,
)
from app.agent.events import AgentEvent
from app.core.config import Settings
from app.core.logging import logger
from app.models.run import Run
from app.services.agents import ChatAgent, ChatAgentOptions, build_chat_agent
from app.services.conversations import materialize_assistant_message
from app.services.conversations.title_jobs import create_title_job
from app.services.run_events.stream import RedisRunEventStream
from app.services.runs.events import RunEvent
from app.services.runs.history import load_conversation_history
from app.services.runs.lifecycle import (
    is_cancelling,
    mark_run_cancelled,
    mark_run_cancelled_if_cancelling,
    mark_run_failed,
    mark_run_succeeded,
    renew_lease,
)
from app.services.runs.service import get_next_run_event_seq, list_run_events_after
from app.services.runs.transcript import append_transcript_message
from app.tasks.llm_tasks import generate_conversation_title
from app.worker.event_sink import (
    DraftCheckpointSink,
    EventSink,
    FanoutSink,
    PostgresEventSink,
    RedisStreamSink,
    external_tool_payload,
)
from app.worker.run_cancel_listener import RunCancelListener

_RunStatus = Literal["succeeded", "failed", "cancelled"]


class ProviderResolver(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider: ...


class _Cancelled(Exception):
    """Raised internally when the run is cancelled mid-stream."""


@dataclass(frozen=True)
class _StreamOutcome:
    status: _RunStatus
    transcript: list[Message]
    last_seq: int
    usage: dict[str, object] | None = None
    provider_request_id: str | None = None
    error: ProviderError | None = None


async def execute_run(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    settings: Settings,
    resolve_provider: ProviderResolver,
    run_event_stream: RedisRunEventStream | None = None,
    run_cancel_listener: RunCancelListener | None = None,
) -> None:
    run_logger = logger.bind(run_id=run_id, worker_id=worker_id)

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            run_logger.warning("Run vanished before execution")
            return
        initial_seq = await get_next_run_event_seq(session, run_id=run_id) - 1
        try:
            history = await load_conversation_history(session, run_id=run_id)
            agent = build_chat_agent(
                settings=settings,
                history=history,
                options=ChatAgentOptions(
                    provider_name=run.provider_name,
                    model=run.provider_model,
                    provider_options=run.provider_options or {},
                ),
                resolve_provider=resolve_provider,
            )
            run.system_prompt_snapshot = agent.system_prompt
        except Exception as exc:
            run_logger.exception("Agent build failed")
            await session.rollback()
            if run_event_stream is not None:
                await _publish_persisted_events(
                    run_event_stream,
                    session_factory=session_factory,
                    run_id=run_id,
                    after_seq=0,
                )
            terminal = await _mark_failed_or_cancelled_if_cancelling(
                session_factory,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
                event_seq=initial_seq + 1,
            )
            await _publish_terminal(run_event_stream, run_id=run_id, event=terminal)
            return
        await session.commit()

    if run_event_stream is not None:
        await _publish_persisted_events(
            run_event_stream,
            session_factory=session_factory,
            run_id=run_id,
            after_seq=0,
        )

    cancel = asyncio.Event()
    if run_cancel_listener is not None:
        run_cancel_listener.register(run_id, cancel)
    try:
        draft_sink = DraftCheckpointSink(
            session_factory=session_factory,
            run_id=run_id,
            cancel=cancel,
            interval_seconds=settings.draft_checkpoint_interval_seconds,
            max_pending_chars=settings.draft_checkpoint_max_pending_chars,
            max_events=settings.run_stream_maxlen,
        )
        child_sinks: list[EventSink] = []
        if run_event_stream is not None:
            child_sinks.append(RedisStreamSink(stream=run_event_stream, run_id=run_id))
        child_sinks.extend(
            [
                PostgresEventSink(
                    session_factory=session_factory,
                    run_id=run_id,
                    cancel=cancel,
                ),
                draft_sink,
            ]
        )
        sink = FanoutSink(*child_sinks, initial_seq=initial_seq)
        heartbeat_task = asyncio.create_task(
            _heartbeat_loop(
                session_factory=session_factory,
                run_id=run_id,
                worker_id=worker_id,
                lease_seconds=settings.run_lease_seconds,
                interval_seconds=settings.worker_heartbeat_interval_seconds,
                cancel=cancel,
            )
        )

        try:
            outcome = await _consume_agent(
                agent=agent,
                sink=sink,
                cancel=cancel,
                initial_seq=initial_seq,
            )
            await sink.flush()
        except Exception as exc:
            run_logger.exception("Agent runtime failed")
            cancel.set()
            with contextlib.suppress(Exception):
                await sink.aclose()
            terminal = await _mark_failed_or_cancelled_if_cancelling(
                session_factory,
                run_id=run_id,
                code="agent_runtime_error",
                message=str(exc),
                event_seq=sink.latest_seq + 1,
            )
            await _publish_terminal(run_event_stream, run_id=run_id, event=terminal)
            with contextlib.suppress(Exception):
                await draft_sink.delete()
            return
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task

        terminal, title_job_created = await _finalize_result(
            session_factory=session_factory,
            run_id=run_id,
            outcome=outcome,
            agent=agent,
            create_title_job_row=settings.auto_title_enabled,
        )
        await _publish_terminal(run_event_stream, run_id=run_id, event=terminal)
        with contextlib.suppress(Exception):
            await draft_sink.delete()

        if title_job_created:
            try:
                generate_conversation_title.apply_async(args=[run_id])
            except Exception:
                run_logger.exception("Failed to enqueue conversation title generation")
    finally:
        if run_cancel_listener is not None:
            run_cancel_listener.unregister(run_id)


async def _consume_agent(
    *,
    agent: ChatAgent,
    sink: EventSink,
    cancel: asyncio.Event,
    initial_seq: int,
) -> _StreamOutcome:
    """Drive ``agent.stream()``: assign seq, map AgentEvents to RunEvents, sink
    them, accumulate the transcript, and apply the retry policy.

    Retry = restart the whole generator, guarded by "nothing forwarded to the
    sink yet". The current rule only ever allowed retry on zero-output/zero-
    transcript — which is exactly the first model call — so restarting the loop
    is equivalent to retrying that first call.
    """
    attempt = 0
    while True:
        attempt += 1
        seq = initial_seq
        transcript: list[Message] = []
        usage: dict[str, object] | None = None
        provider_request_id: str | None = None
        forwarded_any = False

        gen = agent.stream()
        try:
            async for event in _iter_until_cancel(gen, cancel):
                if isinstance(event, MessageDone):
                    transcript.append(event.message)
                elif isinstance(event, AgentFinal):
                    usage = event.usage
                    provider_request_id = event.provider_request_id
                else:
                    seq += 1
                    await sink.emit(
                        _to_run_event(
                            event,
                            seq,
                            tool_backend_names=agent.tool_backend_names,
                        )
                    )
                    forwarded_any = True
            return _StreamOutcome(
                status="succeeded",
                transcript=transcript,
                last_seq=seq,
                usage=usage,
                provider_request_id=provider_request_id,
            )
        except _Cancelled:
            return _StreamOutcome(
                status="cancelled",
                transcript=transcript,
                last_seq=seq,
            )
        except ProviderError as exc:
            retryable = (
                not forwarded_any
                and not transcript
                and attempt < agent.retry_policy.max_attempts
                and agent.retry_policy.is_retryable(exc.code)
                and not cancel.is_set()
            )
            if retryable:
                continue
            return _StreamOutcome(
                status="failed",
                transcript=transcript,
                last_seq=seq,
                error=exc,
            )


async def _iter_until_cancel(
    gen: AsyncIterator[AgentEvent],
    cancel: asyncio.Event,
) -> AsyncIterator[AgentEvent]:
    """Yield events from ``gen`` until it finishes or ``cancel`` is set.

    On cancel, precisely cancel the in-flight ``__anext__`` subtask (propagating
    ``CancelledError`` into the provider/tool await point), close the generator,
    and raise ``_Cancelled``. The sink is never touched here, so buffered deltas
    survive to the caller's ``flush()``.
    """
    cancel_wait = asyncio.ensure_future(cancel.wait())
    try:
        while True:
            step: asyncio.Task[AgentEvent] = asyncio.ensure_future(gen.__anext__())
            await asyncio.wait({step, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
            if cancel.is_set():
                step.cancel()
                with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration, Exception):
                    await step
                aclose = getattr(gen, "aclose", None)
                if aclose is not None:
                    with contextlib.suppress(Exception):
                        await aclose()
                raise _Cancelled
            try:
                event = await step
            except StopAsyncIteration:
                return
            yield event
    finally:
        if not cancel_wait.done():
            cancel_wait.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cancel_wait


def _to_run_event(
    event: AgentEvent,
    seq: int,
    *,
    tool_backend_names: dict[str, str],
) -> RunEvent:
    if isinstance(event, TextDelta):
        return RunEvent(seq=seq, type="text_delta", payload={"text": event.text})
    if isinstance(event, ReasoningDelta):
        return RunEvent(seq=seq, type="reasoning_delta", payload={"text": event.text})
    if isinstance(event, ToolCallStarted):
        internal = RunEvent(
            seq=seq,
            type="tool_call_started",
            payload={"tool_name": event.tool_name, "arguments": event.arguments},
        )
        return RunEvent(
            seq=seq,
            type=internal.type,
            payload=external_tool_payload(
                internal,
                tool_backend_names=tool_backend_names,
            ),
        )
    if isinstance(event, ToolCallFinished):
        internal = RunEvent(
            seq=seq,
            type="tool_call_failed" if event.is_error else "tool_call_succeeded",
            payload={"tool_name": event.tool_name, "metadata": event.metadata},
        )
        return RunEvent(
            seq=seq,
            type=internal.type,
            payload=external_tool_payload(
                internal,
                tool_backend_names=tool_backend_names,
            ),
        )
    raise AssertionError(f"Unexpected sink event: {event!r}")


async def _heartbeat_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    lease_seconds: int,
    interval_seconds: float,
    cancel: asyncio.Event,
) -> None:
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            async with session_factory() as session:
                renewed = await renew_lease(
                    session,
                    run_id=run_id,
                    lease_seconds=lease_seconds,
                    worker_id=worker_id,
                )
                cancelling = await is_cancelling(session, run_id=run_id)
                await session.commit()
            if not renewed or cancelling:
                cancel.set()
                return
        except asyncio.CancelledError:
            return
        except Exception:
            logger.bind(run_id=run_id, worker_id=worker_id).exception("Heartbeat failed")
            cancel.set()
            return


async def _finalize_result(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    outcome: _StreamOutcome,
    agent: ChatAgent,
    create_title_job_row: bool,
) -> tuple[RunEvent | None, bool]:
    terminal_seq = outcome.last_seq + 1
    async with session_factory() as session:
        if outcome.status == "succeeded":
            changed = await mark_run_succeeded(
                session,
                run_id=run_id,
                usage=outcome.usage,
                provider_request_id=outcome.provider_request_id,
                event_seq=terminal_seq,
            )
            if not changed:
                cancelled = await mark_run_cancelled_if_cancelling(
                    session,
                    run_id=run_id,
                    event_seq=terminal_seq,
                )
                await session.commit()
                return (
                    (
                        RunEvent(seq=terminal_seq, type="run_cancelled", payload={})
                        if cancelled
                        else None
                    ),
                    False,
                )

            final = _final_assistant_message(outcome.transcript)
            materialized = await materialize_assistant_message(
                session,
                run_id=run_id,
                content=final.text(),
                reasoning=final.reasoning(),
                metadata=agent.assistant_metadata(),
            )
            await _persist_transcript(
                session,
                run_id=run_id,
                transcript=outcome.transcript,
                count_tokens=agent.count_tokens,
                final_message_id=materialized.id,
            )
            title_job_created = False
            if create_title_job_row:
                title_job_created = await create_title_job(session, run_id=run_id)
            await session.commit()
            return (
                RunEvent(
                    seq=terminal_seq,
                    type="run_succeeded",
                    payload={"usage": outcome.usage} if outcome.usage is not None else {},
                ),
                title_job_created,
            )

        if outcome.status == "cancelled":
            changed = await mark_run_cancelled(
                session,
                run_id=run_id,
                event_seq=terminal_seq,
            )
            terminal = RunEvent(seq=terminal_seq, type="run_cancelled", payload={})
        else:
            changed = await mark_run_cancelled_if_cancelling(
                session,
                run_id=run_id,
                event_seq=terminal_seq,
            )
            if changed:
                terminal = RunEvent(seq=terminal_seq, type="run_cancelled", payload={})
            else:
                error = outcome.error
                code = error.code if error is not None else "unknown_error"
                message = error.message if error is not None else "Agent run failed"
                changed = await mark_run_failed(
                    session,
                    run_id=run_id,
                    code=code,
                    message=message,
                    event_seq=terminal_seq,
                )
                terminal = RunEvent(
                    seq=terminal_seq,
                    type="run_failed",
                    payload={"code": code, "message": message},
                )
        if changed:
            await _persist_transcript(
                session,
                run_id=run_id,
                transcript=outcome.transcript,
                count_tokens=agent.count_tokens,
            )
        await session.commit()
        return (terminal if changed else None), False


async def _persist_transcript(
    session: AsyncSession,
    *,
    run_id: int,
    transcript: list[Message],
    count_tokens: Callable[[str], int],
    final_message_id: int | None = None,
) -> None:
    final_index = len(transcript) - 1 if final_message_id is not None else None
    for index, message in enumerate(transcript):
        await append_transcript_message(
            session,
            run_id=run_id,
            message=message,
            message_id=final_message_id if index == final_index else None,
            count_tokens=count_tokens,
        )


def _final_assistant_message(transcript: list[Message]) -> Message:
    if not transcript or transcript[-1].role != "assistant":
        raise ValueError("Succeeded agent run did not return a final assistant message")
    return transcript[-1]


async def _mark_failed_or_cancelled_if_cancelling(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    run_id: int,
    code: str,
    message: str,
    event_seq: int,
) -> RunEvent | None:
    async with session_factory() as session:
        terminal: RunEvent | None
        cancelled = await mark_run_cancelled_if_cancelling(
            session,
            run_id=run_id,
            event_seq=event_seq,
        )
        if cancelled:
            terminal = RunEvent(seq=event_seq, type="run_cancelled", payload={})
        else:
            failed = await mark_run_failed(
                session,
                run_id=run_id,
                code=code,
                message=message,
                event_seq=event_seq,
            )
            terminal = (
                RunEvent(
                    seq=event_seq,
                    type="run_failed",
                    payload={"code": code, "message": message},
                )
                if failed
                else None
            )
        await session.commit()
        return terminal


async def _publish_persisted_events(
    stream: RedisRunEventStream,
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    after_seq: int,
) -> None:
    try:
        async with session_factory() as session:
            events = await list_run_events_after(session, run_id=run_id, after_seq=after_seq)
        for event in events:
            await stream.append(
                run_id,
                RunEvent(seq=event.seq, type=event.type, payload=event.payload),
                created_at=event.created_at,
            )
    except Exception as exc:
        logger.bind(run_id=run_id, error=str(exc)).warning(
            "Redis run event replay publish failed; continuing with PostgreSQL fallback"
        )


async def _publish_terminal(
    stream: RedisRunEventStream | None,
    *,
    run_id: int,
    event: RunEvent | None,
) -> None:
    if stream is None or event is None:
        return
    try:
        await stream.append(run_id, event, terminal=True)
    except Exception as exc:
        logger.bind(
            run_id=run_id,
            seq=event.seq,
            event_type=event.type,
            error=str(exc),
        ).warning("Redis terminal event append failed; PostgreSQL remains authoritative")
