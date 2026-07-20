import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent import (
    AgentRunner,
    CancellationToken,
    Message,
    Provider,
    ReasoningConfig,
    RunConfig,
    RunResult,
    ToolRegistry,
    WebSearchTool,
    build_context,
    build_system_prompt,
)
from app.core.config import Settings
from app.core.logging import logger
from app.models.run import Run
from app.search import SourceRegistry, resolve_search_client
from app.services.conversations import materialize_assistant_message
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
from app.worker.event_sink import PostgresEventSink
from app.worker.title import maybe_generate_title


class ProviderResolver(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider: ...


def _reasoning_config_from_run(run: Run, settings: Settings) -> ReasoningConfig:
    """Rebuild per-run reasoning options, falling back for legacy rows."""
    options = run.provider_options or {}
    return ReasoningConfig(
        enabled=bool(options.get("thinking_enabled", settings.deepseek_thinking_enabled)),
        effort=str(options.get("reasoning_effort", settings.deepseek_reasoning_effort)),
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
        try:
            provider = resolve_provider(run.provider_name, settings=settings)
            reasoning = _reasoning_config_from_run(run, settings)
            web_search_enabled = _web_search_enabled_from_run(run, settings)
            system_prompt = build_system_prompt(
                settings=settings,
                web_search_enabled=web_search_enabled,
                now=datetime.now(UTC),
            )
            history = await load_conversation_history(session, run_id=run_id)
            messages = build_context(
                system_prompt=system_prompt,
                history=history,
                budget_tokens=settings.context_budget_tokens,
                count_tokens=provider.count_tokens,
            )
            initial_seq = await get_next_run_event_seq(session, run_id=run_id) - 1
            run.system_prompt_snapshot = system_prompt
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
        provider_model = run.provider_model
        await session.commit()

    sources = SourceRegistry()
    tools = ToolRegistry()
    tool_provider_names: dict[str, str] = {}
    if web_search_enabled:
        try:
            search_client = resolve_search_client(
                settings.web_search_provider,
                settings=settings,
            )
            web_search = WebSearchTool(
                settings=settings,
                client=search_client,
                sources=sources,
            )
            tools.register(web_search)
            tool_provider_names[web_search.name] = search_client.name
        except Exception as exc:
            run_logger.exception("Tool setup failed")
            await _mark_failed_or_cancelled_if_cancelling(
                session_factory,
                run_id=run_id,
                code="tool_setup_error",
                message=str(exc),
            )
            return

    cancel = CancellationToken()
    sink = PostgresEventSink(
        session_factory=session_factory,
        run_id=run_id,
        cancel=cancel,
        batch_window_seconds=settings.worker_delta_batch_window_ms / 1000.0,
        batch_max_chars=settings.worker_delta_batch_max_chars,
        tool_provider_names=tool_provider_names,
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
        result = await AgentRunner(provider, initial_seq=initial_seq).run(
            RunConfig(
                messages=messages,
                model=provider_model,
                reasoning=reasoning,
                tools=tools,
                max_tool_calls=(settings.web_search_max_tool_calls if web_search_enabled else 0),
                max_provider_attempts=1 if web_search_enabled else 2,
            ),
            sink,
            cancel,
        )
        await sink.flush()
    except Exception as exc:
        run_logger.exception("Agent runtime failed")
        cancel.cancel()
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
        result=result,
        provider=provider,
        sources=sources.all_metadata(),
    )
    if succeeded:
        await maybe_generate_title(
            session_factory=session_factory,
            run_id=run_id,
            settings=settings,
            resolve_provider=resolve_provider,
        )


async def _heartbeat_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    lease_seconds: int,
    interval_seconds: float,
    cancel: CancellationToken,
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
                cancel.cancel()
                return
        except asyncio.CancelledError:
            return
        except Exception:
            logger.bind(run_id=run_id, worker_id=worker_id).exception("Heartbeat failed")
            cancel.cancel()
            return


async def _finalize_result(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    result: RunResult,
    provider: Provider,
    sources: list[dict[str, object]],
) -> bool:
    async with session_factory() as session:
        if result.status == "succeeded":
            changed = await mark_run_succeeded(
                session,
                run_id=run_id,
                usage=result.usage,
                provider_request_id=result.provider_request_id,
            )
            if not changed:
                await mark_run_cancelled_if_cancelling(session, run_id=run_id)
                await session.commit()
                return False

            final = _final_assistant_message(result.transcript)
            materialized = await materialize_assistant_message(
                session,
                run_id=run_id,
                content=final.text(),
                reasoning=final.reasoning(),
                metadata={"sources": sources} if sources else None,
            )
            await _persist_transcript(
                session,
                run_id=run_id,
                transcript=result.transcript,
                provider=provider,
                final_message_id=materialized.id,
            )
            await session.commit()
            return True

        if result.status == "cancelled":
            changed = await mark_run_cancelled(session, run_id=run_id)
        else:
            changed = await mark_run_cancelled_if_cancelling(session, run_id=run_id)
            if not changed:
                error = result.error
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
                transcript=result.transcript,
                provider=provider,
            )
        await session.commit()
        return False


async def _persist_transcript(
    session: AsyncSession,
    *,
    run_id: int,
    transcript: list[Message],
    provider: Provider,
    final_message_id: int | None = None,
) -> None:
    final_index = len(transcript) - 1 if final_message_id is not None else None
    for index, message in enumerate(transcript):
        await append_transcript_message(
            session,
            run_id=run_id,
            message=message,
            message_id=final_message_id if index == final_index else None,
            count_tokens=provider.count_tokens,
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
