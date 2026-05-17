from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.context import build_context
from app.core.config import Settings
from app.core.logging import logger
from app.models.run import Run
from app.providers import Finish, Provider, ProviderError, TextDelta
from app.services.conversations import materialize_assistant_message
from app.services.runs.lifecycle import (
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
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
                return
    except ProviderError as exc:
        run_logger.bind(code=exc.code).warning("Provider error: %s", exc.message)
        async with session_factory() as session:
            await mark_run_failed(
                session,
                run_id=run_id,
                code=exc.code,
                message=exc.message,
            )
            await session.commit()
        return

    async with session_factory() as session:
        await mark_run_failed(
            session,
            run_id=run_id,
            code="no_finish",
            message="Provider stream ended without finish chunk",
        )
        await session.commit()


def _context_budget_chars() -> int:
    return 16_000
