import asyncio
import contextlib
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol, cast
from uuid import uuid4

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
    ProviderToolCall,
    ReasoningDelta,
    TextDelta,
    ThinkingOptions,
    ToolCallTurn,
)
from app.schemas.runs import RunEventType
from app.search import SourceRegistry, plan_search, resolve_search_client, should_presearch
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
from app.services.runs.transcript import (
    append_provider_message,
    backfill_provider_message_id,
)
from app.tools import (
    WEB_SEARCH_TOOL_SPEC,
    WebSearchArgs,
    args_from_planned_search,
    parse_tool_arguments,
    run_web_search,
    unavailable_result,
    validation_failed_result,
)
from app.tools.types import ToolResult
from app.worker.title import maybe_generate_title

_STREAM_DONE = object()  # sentinel posted on the provider-stream queue
_PRESEARCH_REASONING_CONTENT = "Internal presearch requested before final answer."


class ProviderResolver(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider: ...


def _thinking_options_from_run(run: Run, settings: Settings) -> ThinkingOptions:
    """Rebuild per-run thinking options; fall back to env defaults for legacy
    rows where runs.provider_options is NULL."""
    options = run.provider_options or {}
    return ThinkingOptions(
        enabled=bool(options.get("thinking_enabled", settings.deepseek_thinking_enabled)),
        reasoning_effort=str(
            options.get("reasoning_effort", settings.deepseek_reasoning_effort)
        ),
    )


def _web_search_enabled_from_run(run: Run, settings: Settings) -> bool:
    options = run.provider_options or {}
    return bool(options.get("web_search_enabled", False)) and settings.web_search_available


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
        thinking = _thinking_options_from_run(run, settings)
        web_search_enabled = _web_search_enabled_from_run(run, settings)
        provider = resolve_provider(provider_name, settings=settings)
        try:
            messages = await build_context(
                session,
                run_id=run_id,
                system_prompt=settings.default_system_prompt,
                budget_tokens=settings.context_budget_tokens,
                count_tokens=provider.count_tokens,
                # When tools aren't registered for this run, replayed tool-call
                # turns from prior web-search runs would make DeepSeek echo raw
                # tool-call markup as text; strip them from history.
                include_tool_messages=web_search_enabled,
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
        if web_search_enabled:
            outcome = await _run_agent_loop_until_done_or_cancelled(
                session_factory=session_factory,
                run_id=run_id,
                provider=provider,
                provider_model=provider_model,
                messages=messages,
                thinking=thinking,
                cancel_event=cancel_event,
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

        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            outcome = await _run_provider_stream_until_done_or_cancelled(
                session_factory=session_factory,
                run_id=run_id,
                provider=provider,
                provider_model=provider_model,
                messages=messages,
                thinking=thinking,
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


async def _run_agent_loop_until_done_or_cancelled(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    thinking: ThinkingOptions,
    cancel_event: asyncio.Event,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> _StreamOutcome:
    agent_task = asyncio.create_task(
        _run_agent_loop(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            provider_model=provider_model,
            messages=messages,
            thinking=thinking,
            cancel_event=cancel_event,
            settings=settings,
            resolve_provider=resolve_provider,
        )
    )
    cancel_task = asyncio.create_task(cancel_event.wait())
    try:
        done, _ = await asyncio.wait(
            {agent_task, cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancel_task in done and cancel_event.is_set() and not agent_task.done():
            agent_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await agent_task
            async with session_factory() as session:
                delta_persisted = await run_has_text_delta(session, run_id=run_id)
            return _StreamOutcome(
                status="cancelled",
                before_first_delta=not delta_persisted,
                delta_persisted=delta_persisted,
            )
        return await agent_task
    finally:
        for task in (agent_task, cancel_task):
            if not task.done():
                task.cancel()
        for task in (agent_task, cancel_task):
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def _run_agent_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    thinking: ThinkingOptions,
    cancel_event: asyncio.Event,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> _StreamOutcome:
    provider_messages = list(messages)
    registry = SourceRegistry()
    search_client = resolve_search_client(settings.web_search_provider, settings=settings)
    streaming_started = False
    tool_calls_used = 0
    user_content = _latest_user_content(provider_messages)

    async def append_tool_event(event_type: str, payload: dict[str, object]) -> bool:
        nonlocal streaming_started
        async with session_factory() as session:
            if not streaming_started:
                changed = await mark_run_streaming(session, run_id=run_id)
                if not changed:
                    await session.commit()
                    return False
                streaming_started = True
            await append_run_event(
                session,
                run_id=run_id,
                event_type=cast(RunEventType, event_type),
                payload=payload,
            )
            await session.commit()
        return True

    async def persist_delta(channel: str, text: str) -> bool:
        nonlocal streaming_started
        async with session_factory() as session:
            if not streaming_started:
                changed = await mark_run_streaming(session, run_id=run_id)
                if not changed:
                    await session.commit()
                    return False
                streaming_started = True
            # Pass the event type as a literal (not a variable) so it satisfies the
            # RunEventType Literal accepted by append_run_event under mypy.
            if channel == "reasoning":
                await append_run_event(
                    session, run_id=run_id, event_type="reasoning_delta", payload={"text": text}
                )
            else:
                await append_run_event(
                    session, run_id=run_id, event_type="text_delta", payload={"text": text}
                )
            await session.commit()
        return True

    async def execute_args(args: WebSearchArgs) -> ToolResult:
        nonlocal tool_calls_used
        if tool_calls_used >= settings.web_search_max_tool_calls:
            result = validation_failed_result(
                "Web search tool call limit reached. Continuing without more live results.",
                provider=search_client.name,
                query=args.query,
            )
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
            return result
        tool_calls_used += 1
        if not settings.web_search_available:
            result = unavailable_result(provider=settings.web_search_provider, query=args.query)
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
            return result
        if not await append_tool_event(
            "tool_call_started",
            {
                "tool_name": "web_search",
                "query": args.query,
                "provider": search_client.name,
            },
        ):
            return validation_failed_result(
                "Run is no longer active.",
                provider=search_client.name,
                query=args.query,
            )
        result = await run_web_search(
            args=args,
            client=search_client,
            registry=registry,
            settings=settings,
        )
        if result.status == "succeeded":
            await append_tool_event(
                "tool_call_succeeded",
                {
                    "tool_name": "web_search",
                    "query": args.query,
                    "provider": search_client.name,
                    "result_count": result.payload.get("result_count", 0),
                    "sources": result.sources,
                },
            )
        else:
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
        return result

    async def execute_call(call: ProviderToolCall) -> ToolResult:
        nonlocal tool_calls_used
        if call.name != "web_search":
            result = validation_failed_result(
                f"Unsupported tool: {call.name}.",
                provider=search_client.name,
                query=None,
            )
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
            return result
        if tool_calls_used >= settings.web_search_max_tool_calls:
            result = validation_failed_result(
                "Web search tool call limit reached. Continuing without more live results.",
                provider=search_client.name,
                query=None,
            )
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
            return result
        tool_calls_used += 1
        try:
            args = parse_tool_arguments(call.arguments, settings=settings)
        except ValueError as exc:
            result = validation_failed_result(str(exc), provider=search_client.name, query=None)
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
            return result
        if not settings.web_search_available:
            result = unavailable_result(provider=settings.web_search_provider, query=args.query)
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
            return result
        if not await append_tool_event(
            "tool_call_started",
            {
                "tool_name": "web_search",
                "query": args.query,
                "provider": search_client.name,
            },
        ):
            return validation_failed_result(
                "Run is no longer active.",
                provider=search_client.name,
                query=args.query,
            )
        result = await run_web_search(
            args=args,
            client=search_client,
            registry=registry,
            settings=settings,
        )
        if result.status == "succeeded":
            await append_tool_event(
                "tool_call_succeeded",
                {
                    "tool_name": "web_search",
                    "query": args.query,
                    "provider": search_client.name,
                    "result_count": result.payload.get("result_count", 0),
                    "sources": result.sources,
                },
            )
        else:
            await append_tool_event("tool_call_failed", _tool_failed_payload(result))
        return result

    if should_presearch(user_content):
        plan = plan_search(user_content)
        call = ProviderToolCall(
            id=f"presearch_{run_id}_{uuid4().hex[:8]}",
            name="web_search",
            arguments=json.dumps(
                {
                    "query": plan.query,
                    "max_results": plan.max_results or settings.web_search_default_max_results,
                    "recency": plan.recency,
                    "search_depth": plan.depth,
                    "extract": plan.extract,
                    "include_domains": plan.include_domains,
                    "exclude_domains": plan.exclude_domains,
                },
                ensure_ascii=False,
            ),
        )
        assistant_message = ProviderMessage(
            role="assistant",
            content=None,
            reasoning_content=_PRESEARCH_REASONING_CONTENT,
            tool_calls=[call],
        )
        provider_messages.append(assistant_message)
        async with session_factory() as session:
            await append_provider_message(
                session,
                run_id=run_id,
                role="assistant",
                content=None,
                reasoning_content=_PRESEARCH_REASONING_CONTENT,
                tool_calls=[call],
                payload={"kind": "presearch"},
                count_tokens=provider.count_tokens,
            )
            await session.commit()
        result = await execute_args(args_from_planned_search(plan, settings=settings))
        await _append_tool_result_transcript(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            call=call,
            result=result,
            provider_messages=provider_messages,
        )

    while True:
        if cancel_event.is_set():
            return _StreamOutcome("cancelled", not streaming_started, streaming_started)
        turn = await _stream_provider_turn(
            provider=provider,
            provider_model=provider_model,
            messages=provider_messages,
            thinking=thinking,
            cancel_event=cancel_event,
            batch_window_seconds=settings.worker_delta_batch_window_ms / 1000.0,
            batch_max_chars=settings.worker_delta_batch_max_chars,
            persist_delta=persist_delta,
        )
        if turn is None:
            return _StreamOutcome(
                status="cancelled",
                before_first_delta=not streaming_started,
                delta_persisted=streaming_started,
            )
        if isinstance(turn, _ProviderTurnError):
            return _StreamOutcome(
                status="failed",
                before_first_delta=not streaming_started,
                delta_persisted=False,
                code=turn.code,
                message=turn.message,
            )
        if turn.tool_turn is not None:
            tool_turn = turn.tool_turn
            provider_messages.append(
                ProviderMessage(
                    role="assistant",
                    content=tool_turn.content,
                    reasoning_content=tool_turn.reasoning_content,
                    tool_calls=tool_turn.tool_calls,
                )
            )
            async with session_factory() as session:
                await append_provider_message(
                    session,
                    run_id=run_id,
                    role="assistant",
                    content=tool_turn.content,
                    reasoning_content=tool_turn.reasoning_content,
                    tool_calls=tool_turn.tool_calls,
                    count_tokens=provider.count_tokens,
                )
                await session.commit()
            for call in tool_turn.tool_calls:
                result = await execute_call(call)
                await _append_tool_result_transcript(
                    session_factory=session_factory,
                    run_id=run_id,
                    provider=provider,
                    call=call,
                    result=result,
                    provider_messages=provider_messages,
                )
            continue

        if turn.finish is None:
            return _StreamOutcome(
                status="failed",
                before_first_delta=not streaming_started,
                delta_persisted=False,
                code="no_finish",
                message="Provider stream ended without finish chunk",
            )
        sources = registry.all_metadata()
        changed = await _persist_agent_success(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            finish=turn.finish,
            content=turn.content,
            reasoning=turn.reasoning_content,
            sources=sources,
        )
        if not changed:
            return _StreamOutcome(
                status="cancelled",
                before_first_delta=not streaming_started,
                delta_persisted=streaming_started,
            )
        await maybe_generate_title(
            session_factory=session_factory,
            run_id=run_id,
            settings=settings,
            resolve_provider=resolve_provider,
        )
        return _StreamOutcome(
            status="succeeded",
            before_first_delta=not streaming_started,
            delta_persisted=bool(turn.content),
        )


@dataclass
class _ProviderTurn:
    content: str
    reasoning_content: str | None
    finish: Finish | None
    tool_turn: ToolCallTurn | None = None


@dataclass
class _ProviderTurnError:
    code: str
    message: str


async def _stream_provider_turn(
    *,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    thinking: ThinkingOptions,
    cancel_event: asyncio.Event,
    batch_window_seconds: float,
    batch_max_chars: int,
    persist_delta: Callable[[str, str], Awaitable[bool]],
) -> _ProviderTurn | _ProviderTurnError | None:
    """Stream one provider turn, persisting text/reasoning deltas live (batched
    like the non-tool path) so the final answer streams to the frontend.

    Returns None when the run is no longer active (cancelled while persisting).
    """
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    pending: list[str] = []
    pending_chars = 0
    pending_channel: str | None = None  # "text" | "reasoning"
    window_started_at = 0.0

    async def flush_pending() -> bool:
        nonlocal pending_chars, pending_channel
        if not pending:
            return True
        ok = await persist_delta(pending_channel or "text", "".join(pending))
        pending.clear()
        pending_chars = 0
        pending_channel = None
        return ok

    # Same producer/queue pattern as _run_provider_stream: drive the provider
    # stream from a background task so the batch window can elapse without
    # cancelling the stream's coroutine.
    queue: asyncio.Queue[object] = asyncio.Queue()

    async def _producer() -> None:
        try:
            async for produced in provider.stream(
                model=provider_model,
                messages=messages,
                thinking=thinking,
                tools=[WEB_SEARCH_TOOL_SPEC],
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
                    return None
                continue

            if item is _STREAM_DONE:
                break

            if isinstance(item, ProviderError):
                if pending:
                    with contextlib.suppress(Exception):
                        await flush_pending()
                return _ProviderTurnError(code=item.code, message=item.message)

            chunk = item

            if cancel_event.is_set():
                await flush_pending()
                return None

            if isinstance(chunk, (TextDelta, ReasoningDelta)):
                channel = "reasoning" if isinstance(chunk, ReasoningDelta) else "text"
                # Channel switch: flush the previous channel before buffering the new one,
                # so reasoning_delta events strictly precede text_delta events in seq order.
                if pending and pending_channel != channel:
                    if not await flush_pending():
                        return None
                if not pending:
                    window_started_at = time.monotonic()
                    pending_channel = channel
                if channel == "reasoning":
                    reasoning_parts.append(chunk.text)
                else:
                    content_parts.append(chunk.text)
                pending.append(chunk.text)
                pending_chars += len(chunk.text)
                if pending_chars >= batch_max_chars and not await flush_pending():
                    return None
            elif isinstance(chunk, ToolCallTurn):
                if not await flush_pending():
                    return None
                return _ProviderTurn(
                    content=chunk.content or "",
                    reasoning_content=chunk.reasoning_content,
                    finish=None,
                    tool_turn=chunk,
                )
            elif isinstance(chunk, Finish):
                if not await flush_pending():
                    return None
                return _ProviderTurn(
                    content="".join(content_parts),
                    reasoning_content="".join(reasoning_parts) or None,
                    finish=chunk,
                )
    finally:
        if not producer_task.done():
            producer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await producer_task

    # Stream ended without Finish or ToolCallTurn
    with contextlib.suppress(Exception):
        await flush_pending()
    return _ProviderTurn(content="".join(content_parts), reasoning_content=None, finish=None)


async def _append_tool_result_transcript(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    call: ProviderToolCall,
    result: ToolResult,
    provider_messages: list[ProviderMessage],
) -> None:
    provider_messages.append(
        ProviderMessage(
            role="tool",
            content=result.content,
            tool_call_id=call.id,
            tool_name=call.name,
        )
    )
    async with session_factory() as session:
        await append_provider_message(
            session,
            run_id=run_id,
            role="tool",
            content=result.content,
            tool_call_id=call.id,
            tool_name=call.name,
            payload={**result.payload, "tool_call_id": call.id},
            count_tokens=provider.count_tokens,
        )
        await session.commit()


async def _persist_agent_success(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    finish: Finish,
    content: str,
    reasoning: str | None,
    sources: list[dict[str, object]],
) -> bool:
    async with session_factory() as session:
        changed = await mark_run_succeeded(
            session,
            run_id=run_id,
            usage=finish.usage,
            provider_request_id=finish.provider_request_id,
        )
        if not changed:
            await session.commit()
            return False
        provider_row = await append_provider_message(
            session,
            run_id=run_id,
            role="assistant",
            content=content,
            reasoning_content=reasoning,
            payload={"kind": "final"},
            count_tokens=provider.count_tokens,
        )
        message = await materialize_assistant_message(
            session,
            run_id=run_id,
            content=content,
            reasoning=reasoning,
            metadata={"sources": sources} if sources else None,
        )
        await backfill_provider_message_id(
            session,
            provider_message_id=provider_row.id,
            message_id=message.id,
        )
        await session.commit()
        return True


def _latest_user_content(messages: list[ProviderMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user" and isinstance(message.content, str):
            return message.content
    return ""


def _tool_failed_payload(result: ToolResult) -> dict[str, object]:
    return {
        "tool_name": "web_search",
        "query": result.payload.get("query"),
        "provider": result.payload.get("provider", "tavily"),
        "error_code": result.error_code or result.payload.get("error_code", "search_error"),
        "message": result.message or result.payload.get("message", "Web search failed."),
    }


async def _run_provider_stream_until_done_or_cancelled(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    thinking: ThinkingOptions,
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
            thinking=thinking,
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
    thinking: ThinkingOptions,
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
                model=provider_model, messages=messages, thinking=thinking
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
                        provider_row = await append_provider_message(
                            session,
                            run_id=run_id,
                            role="assistant",
                            content=full_text,
                            reasoning_content=full_reasoning or None,
                            payload={"kind": "final"},
                            count_tokens=provider.count_tokens,
                        )
                        message = await materialize_assistant_message(
                            session,
                            run_id=run_id,
                            content=full_text,
                            reasoning=full_reasoning or None,
                        )
                        await backfill_provider_message_id(
                            session,
                            provider_message_id=provider_row.id,
                            message_id=message.id,
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
