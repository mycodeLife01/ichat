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
from app.services.runs.service import get_next_run_event_seq
from app.services.runs.transcript import append_transcript_message
from app.worker.event_sink import EventSink, PostgresEventSink
from app.worker.title import maybe_generate_title

_RunStatus = Literal["succeeded", "failed", "cancelled"]


class ProviderResolver(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider: ...


class _Cancelled(Exception):
    """Raised internally when the run is cancelled mid-stream."""


@dataclass(frozen=True)
class _StreamOutcome:
    status: _RunStatus
    transcript: list[Message]
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
) -> None:
    run_logger = logger.bind(run_id=run_id, worker_id=worker_id)

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            run_logger.warning("Run vanished before execution")
            return
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
            initial_seq = await get_next_run_event_seq(session, run_id=run_id) - 1
            run.system_prompt_snapshot = agent.system_prompt
        except Exception as exc:
            run_logger.exception("Agent build failed")
            await session.rollback()
            await _mark_failed_or_cancelled_if_cancelling(
                session_factory,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
            )
            return
        await session.commit()

    cancel = asyncio.Event()
    sink = PostgresEventSink(
        session_factory=session_factory,
        run_id=run_id,
        cancel=cancel,
        batch_window_seconds=settings.worker_delta_batch_window_ms / 1000.0,
        batch_max_chars=settings.worker_delta_batch_max_chars,
        tool_backend_names=agent.tool_backend_names,
    )
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
        await _mark_failed_or_cancelled_if_cancelling(
            session_factory,
            run_id=run_id,
            code="agent_runtime_error",
            message=str(exc),
        )
        return
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task

    succeeded = await _finalize_result(
        session_factory=session_factory,
        run_id=run_id,
        outcome=outcome,
        agent=agent,
    )
    if succeeded:
        await maybe_generate_title(
            session_factory=session_factory,
            run_id=run_id,
            settings=settings,
            resolve_provider=resolve_provider,
        )


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
                    await sink.emit(_to_run_event(event, seq))
                    forwarded_any = True
            return _StreamOutcome(
                status="succeeded",
                transcript=transcript,
                usage=usage,
                provider_request_id=provider_request_id,
            )
        except _Cancelled:
            return _StreamOutcome(status="cancelled", transcript=transcript)
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
            return _StreamOutcome(status="failed", transcript=transcript, error=exc)


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


def _to_run_event(event: AgentEvent, seq: int) -> RunEvent:
    if isinstance(event, TextDelta):
        return RunEvent(seq=seq, type="text_delta", payload={"text": event.text})
    if isinstance(event, ReasoningDelta):
        return RunEvent(seq=seq, type="reasoning_delta", payload={"text": event.text})
    if isinstance(event, ToolCallStarted):
        return RunEvent(
            seq=seq,
            type="tool_call_started",
            payload={"tool_name": event.tool_name, "arguments": event.arguments},
        )
    if isinstance(event, ToolCallFinished):
        return RunEvent(
            seq=seq,
            type="tool_call_failed" if event.is_error else "tool_call_succeeded",
            payload={"tool_name": event.tool_name, "metadata": event.metadata},
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
) -> bool:
    async with session_factory() as session:
        if outcome.status == "succeeded":
            changed = await mark_run_succeeded(
                session,
                run_id=run_id,
                usage=outcome.usage,
                provider_request_id=outcome.provider_request_id,
            )
            if not changed:
                await mark_run_cancelled_if_cancelling(session, run_id=run_id)
                await session.commit()
                return False

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
            await session.commit()
            return True

        if outcome.status == "cancelled":
            changed = await mark_run_cancelled(session, run_id=run_id)
        else:
            changed = await mark_run_cancelled_if_cancelling(session, run_id=run_id)
            if not changed:
                error = outcome.error
                changed = await mark_run_failed(
                    session,
                    run_id=run_id,
                    code=error.code if error is not None else "unknown_error",
                    message=error.message if error is not None else "Agent run failed",
                )
        if changed:
            await _persist_transcript(
                session,
                run_id=run_id,
                transcript=outcome.transcript,
                count_tokens=agent.count_tokens,
            )
        await session.commit()
        return False


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
