# ruff: noqa: E402

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent, RunProviderMessage
from app.models.user import User
from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ProviderToolCall,
    TextDelta,
    ThinkingOptions,
    ToolCallTurn,
    ToolSpec,
)
from app.services.runs.service import append_run_event
from app.worker.executor import ProviderResolver, execute_run

SMOKE_EMAIL_DOMAIN = "web-search-smoke.local"
SMOKE_WORKER_ID = "web-search-smoke"


class SmokeProvider(Provider):
    def __init__(self, *, query: str) -> None:
        self.query = query
        self.calls = 0

    @property
    def name(self) -> str:
        return "fake-deepseek-smoke"

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        thinking: ThinkingOptions | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> AsyncIterator[ProviderChunk]:
        self.calls += 1
        if self.calls == 1:
            if not tools:
                raise ProviderError(
                    code="smoke_missing_tools",
                    message="Smoke provider expected web_search tool schema.",
                )
            yield ToolCallTurn(
                reasoning_content="Need live web evidence for smoke verification.",
                tool_calls=[
                    ProviderToolCall(
                        id="smoke_call_1",
                        name="web_search",
                        arguments=json.dumps(
                            {
                                "query": self.query,
                                "max_results": 3,
                                "search_depth": "basic",
                                "extract": False,
                            }
                        ),
                    )
                ],
            )
            return

        if not any(message.role == "tool" for message in messages):
            raise ProviderError(
                code="smoke_missing_tool_result",
                message="Smoke provider expected a tool result before final answer.",
            )
        yield TextDelta(text="Web search smoke completed with source [1].")
        yield Finish(
            finish_reason="stop",
            usage={"prompt_tokens": 1, "completion_tokens": 1},
            provider_request_id="fake-smoke-request",
        )

    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        return "Web search smoke"


async def clean_smoke_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{SMOKE_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(RunProviderMessage).where(RunProviderMessage.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


async def create_started_smoke_run(
    session: AsyncSession,
    *,
    settings: Settings,
) -> int:
    suffix = uuid4().hex[:16]
    user = User(
        username=f"web-smoke-{suffix}",
        email=f"web-smoke-{suffix}@{SMOKE_EMAIL_DOMAIN}",
        password_hash="smoke-not-a-login-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="Web search smoke")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Run the worker smoke check.",
        position=1,
    )
    session.add(message)
    await session.flush()

    now = datetime.now(UTC)
    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="started",
        provider_name="fake-deepseek-smoke",
        provider_model="fake-smoke-model",
        provider_options={
            "thinking_enabled": True,
            "reasoning_effort": "max",
            "web_search_enabled": True,
            "web_search_suppressed_by_user": False,
        },
        system_prompt_snapshot=settings.default_system_prompt,
        lease_owner=SMOKE_WORKER_ID,
        lease_expires_at=now + timedelta(seconds=settings.run_lease_seconds),
        heartbeat_at=now,
        started_at=now,
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
    await session.flush()
    return run.id


async def verify_smoke_result(
    session: AsyncSession,
    *,
    run_id: int,
) -> dict[str, object]:
    run = await session.get(Run, run_id)
    if run is None:
        raise RuntimeError(f"Smoke run {run_id} vanished.")
    if run.status != "succeeded":
        raise RuntimeError(f"Smoke run ended with status={run.status!r}: {run.error_message}")

    events = (
        await session.scalars(
            select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
        )
    ).all()
    event_types = [event.type for event in events]
    for expected in ("tool_call_started", "tool_call_succeeded", "text_delta", "run_succeeded"):
        if expected not in event_types:
            raise RuntimeError(f"Smoke run missing event {expected!r}; saw {event_types!r}.")

    assistant = await session.scalar(
        select(Message).where(Message.run_id == run_id, Message.role == "assistant")
    )
    if assistant is None:
        raise RuntimeError("Smoke run did not materialize an assistant message.")
    sources = (assistant.metadata_ or {}).get("sources")
    if not isinstance(sources, list) or not sources:
        raise RuntimeError("Smoke assistant message did not contain metadata.sources.")

    transcript = (
        await session.scalars(
            select(RunProviderMessage)
            .where(RunProviderMessage.run_id == run_id)
            .order_by(RunProviderMessage.seq.asc())
        )
    ).all()
    roles = [row.role for row in transcript]
    if roles != ["assistant", "tool", "assistant"]:
        raise RuntimeError(f"Unexpected provider transcript roles: {roles!r}.")

    first_source = sources[0]
    return {
        "run_id": run_id,
        "event_types": event_types,
        "source_count": len(sources),
        "first_source_title": first_source.get("title"),
        "first_source_url": first_source.get("url"),
        "transcript_roles": roles,
    }


def resolve_smoke_provider(provider: Provider) -> ProviderResolver:
    def resolve(name: str, *, settings: Settings) -> Provider:
        return provider

    return resolve


def validate_prerequisites(settings: Settings) -> list[str]:
    missing = []
    if not settings.web_search_enabled:
        missing.append("WEB_SEARCH_ENABLED=true")
    if not settings.tavily_api_key.strip():
        missing.append("TAVILY_API_KEY")
    if settings.web_search_provider != "tavily":
        missing.append("WEB_SEARCH_PROVIDER=tavily")
    return missing


async def run_smoke(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.database_url:
        settings = settings.model_copy(update={"database_url": args.database_url})

    missing = validate_prerequisites(settings)
    if missing:
        print("SKIP web search worker smoke: missing " + ", ".join(missing))
        return 2

    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    provider = SmokeProvider(query=args.query)
    try:
        async with session_factory() as session:
            await clean_smoke_data(session)
            run_id = await create_started_smoke_run(session, settings=settings)
            await session.commit()

        await execute_run(
            session_factory=session_factory,
            run_id=run_id,
            worker_id=SMOKE_WORKER_ID,
            settings=settings,
            resolve_provider=resolve_smoke_provider(provider),
        )

        async with session_factory() as session:
            result = await verify_smoke_result(session, run_id=run_id)
            await session.commit()

        print(json.dumps(result, ensure_ascii=False, indent=2))
        if not args.keep_data:
            async with session_factory() as session:
                await clean_smoke_data(session)
                await session.commit()
        return 0
    finally:
        await engine.dispose()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a worker-level web_search smoke with real Tavily and fake DeepSeek.",
    )
    parser.add_argument(
        "--query",
        default="site:openai.com OpenAI latest news",
        help="Search query sent to Tavily.",
    )
    parser.add_argument(
        "--database-url",
        help="Override DATABASE_URL for the smoke run.",
    )
    parser.add_argument(
        "--keep-data",
        action="store_true",
        help="Keep smoke rows in the database after a successful run.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run_smoke(parse_args())))
