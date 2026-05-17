import asyncio
import contextlib
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.context import build_context
from app.core.config import Settings
from app.core.logging import logger
from app.models.run import Run
from app.providers import Finish, Provider, ProviderError, ProviderMessage, TextDelta
from app.services.conversations import materialize_assistant_message
from app.services.runs.lifecycle import (
    is_cancelling,
    mark_run_cancelled,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    renew_lease,
    run_has_text_delta,
)
from app.services.runs.service import append_run_event


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
        try:
            messages = await build_context(
                session,
                run_id=run_id,
                system_prompt=settings.default_system_prompt,
                budget_chars=_context_budget_chars(),
            )
        except Exception as exc:
            run_logger.exception("Context build failed")
            await mark_run_failed(
                session,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
            )
            await session.commit()
            return
        provider_name = run.provider_name
        provider_model = run.provider_model
        await session.commit()

    provider = resolve_provider(provider_name, settings=settings)

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
            outcome = await _run_provider_stream(
                session_factory=session_factory,
                run_id=run_id,
                provider=provider,
                provider_model=provider_model,
                messages=messages,
                cancel_event=cancel_event,
            )
            if outcome.status == "succeeded":
                return
            if outcome.status == "cancelled":
                async with session_factory() as session:
                    await mark_run_cancelled(session, run_id=run_id)
                    await session.commit()
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
            async with session_factory() as session:
                await mark_run_failed(
                    session,
                    run_id=run_id,
                    code=outcome.code or "unknown_error",
                    message=outcome.message or "",
                )
                await session.commit()
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
                return
        except asyncio.CancelledError:
            return


@dataclass
class _StreamOutcome:
    status: str  # "succeeded" | "failed" | "cancelled"
    before_first_delta: bool
    delta_persisted: bool
    code: str | None = None
    message: str | None = None


async def _run_provider_stream(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages: list[ProviderMessage],
    cancel_event: asyncio.Event,
) -> _StreamOutcome:
    text_parts: list[str] = []
    first_delta_seen = False

    try:
        async for chunk in provider.stream(model=provider_model, messages=messages):
            if cancel_event.is_set():
                return _StreamOutcome(
                    status="cancelled",
                    before_first_delta=not first_delta_seen,
                    delta_persisted=first_delta_seen,
                )
            if isinstance(chunk, TextDelta):
                async with session_factory() as session:
                    if not first_delta_seen:
                        await mark_run_streaming(session, run_id=run_id)
                        first_delta_seen = True
                    await append_run_event(
                        session,
                        run_id=run_id,
                        event_type="text_delta",
                        payload={"text": chunk.text},
                    )
                    await session.commit()
                text_parts.append(chunk.text)
                if cancel_event.is_set():
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=False,
                        delta_persisted=True,
                    )
            elif isinstance(chunk, Finish):
                full_text = "".join(text_parts)
                async with session_factory() as session:
                    await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    await materialize_assistant_message(
                        session,
                        run_id=run_id,
                        content=full_text,
                    )
                    await session.commit()
                return _StreamOutcome(
                    status="succeeded",
                    before_first_delta=not first_delta_seen,
                    delta_persisted=first_delta_seen,
                )
    except ProviderError as exc:
        async with session_factory() as session:
            delta_persisted = await run_has_text_delta(session, run_id=run_id)
        return _StreamOutcome(
            status="failed",
            before_first_delta=not first_delta_seen,
            delta_persisted=delta_persisted,
            code=exc.code,
            message=exc.message,
        )

    async with session_factory() as session:
        delta_persisted = await run_has_text_delta(session, run_id=run_id)
    return _StreamOutcome(
        status="failed",
        before_first_delta=not first_delta_seen,
        delta_persisted=delta_persisted,
        code="no_finish",
        message="Provider stream ended without finish chunk",
    )


def _context_budget_chars() -> int:
    return 16_000
