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
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
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

    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        outcome = await _run_provider_stream(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            provider_model=provider_model,
            messages=messages,
        )
        if outcome.status == "succeeded":
            return
        if outcome.status == "failed":
            allow_retry = (
                outcome.before_first_delta
                and not outcome.delta_persisted
                and attempt < max_attempts
            )
            if allow_retry:
                run_logger.bind(code=outcome.code).info("Retrying provider stream once")
                continue
            async with session_factory() as session:
                await mark_run_failed(
                    session,
                    run_id=run_id,
                    code=outcome.code or "unknown_error",
                    message=outcome.message or "",
                )
                await session.commit()
            return


@dataclass
class _StreamOutcome:
    status: str  # "succeeded" | "failed"
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
) -> _StreamOutcome:
    text_parts: list[str] = []
    first_delta_seen = False

    try:
        async for chunk in provider.stream(model=provider_model, messages=messages):
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
