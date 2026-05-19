import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Provider, ProviderError
from app.worker.executor import ProviderResolver
from app.worker.title import maybe_generate_title, normalize_generated_title
from tests.providers.fake import FakeProvider

TEST_DATABASE_URL = os.environ.get(
    "AUTO_TITLE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "auto-title-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


@pytest.fixture()
def settings() -> Settings:
    return get_settings().model_copy(
        update={
            "auto_title_enabled": True,
            "summary_provider_name": "fake",
            "summary_model": "fake-summary",
            "auto_title_max_chars": 32,
            "auto_title_max_output_tokens": 40,
        }
    )


def make_resolver(provider: Provider) -> ProviderResolver:
    def resolve(name: str, *, settings: Settings) -> Provider:
        assert name == "fake"
        return provider

    return resolve


async def seed_succeeded_turn(
    session: AsyncSession,
    *,
    title: str | None,
    succeeded_runs: int = 1,
) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"title-{suffix}",
        email=f"title-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(
        user_id=user.id,
        title=title,
        activated_at=datetime.now(UTC),
    )
    session.add(conversation)
    await session.flush()

    first_run_id = 0
    for index in range(succeeded_runs):
        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content=f"User asks question {index}",
            position=index * 2 + 1,
        )
        session.add(user_message)
        await session.flush()

        run = Run(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="fake",
            provider_model="fake-model",
        )
        session.add(run)
        await session.flush()
        user_message.run_id = run.id

        assistant_message = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content=f"Assistant answer {index}",
            position=index * 2 + 2,
        )
        session.add(assistant_message)
        await session.flush()
        if index == 0:
            first_run_id = run.id

    return first_run_id


def test_normalize_generated_title_strips_wrappers_prefix_whitespace_and_truncates() -> None:
    title = normalize_generated_title(
        "  《标题：  Project\nPlan For iChat Backend》  ",
        max_chars=12,
    )

    assert title == "Project Plan"


def test_normalize_generated_title_returns_none_for_blank() -> None:
    assert normalize_generated_title("   ", max_chars=32) is None


async def test_maybe_generate_title_writes_first_success_title(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title=None)
        await session.commit()

    provider = FakeProvider(script=[], summarize_result=' "标题：  Travel\nPlan  " ')
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title == "Travel Plan"


async def test_maybe_generate_title_does_not_overwrite_manual_title(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title="Manual title")
        await session.commit()

    provider = FakeProvider(script=[], summarize_result="Generated title")
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title == "Manual title"


async def test_maybe_generate_title_skips_when_succeeded_count_is_not_one(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title=None, succeeded_runs=2)
        await session.commit()

    provider = FakeProvider(script=[], summarize_result="Generated title")
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title is None


async def test_maybe_generate_title_swallows_provider_error(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title=None)
        await session.commit()

    provider = FakeProvider(
        script=[],
        summarize_result=ProviderError(code="summary_failed", message="boom"),
    )
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title is None
