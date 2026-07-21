import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.conversation import Conversation, Message
from app.models.run import Run, RunDraft
from app.models.user import User
from app.services.runs.drafts import delete_run_draft, get_run_draft, upsert_run_draft

TEST_DATABASE_URL = os.environ.get(
    "RUN_DRAFT_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "run-draft-test.example.com"


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await _clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await _clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def _clean_test_data(session: AsyncSession) -> None:
    await session.execute(delete(User).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")))


async def _seed_run(session: AsyncSession) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"draft-{suffix}",
        email=f"draft-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()
    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()
    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="streaming",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    return run.id


async def test_run_draft_upsert_overwrites_snapshot_and_delete_removes_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run_id = await _seed_run(session)
        await upsert_run_draft(
            session,
            run_id=run_id,
            seq=2,
            text="Hel",
            reasoning="Think",
        )
        await upsert_run_draft(
            session,
            run_id=run_id,
            seq=4,
            text="Hello",
            reasoning="Thinking",
        )
        await session.commit()

    async with session_factory() as session:
        draft = await get_run_draft(session, run_id=run_id)
        assert draft is not None
        assert (draft.seq, draft.text, draft.reasoning) == (4, "Hello", "Thinking")
        await delete_run_draft(session, run_id=run_id)
        await session.commit()

    async with session_factory() as session:
        assert await session.get(RunDraft, run_id) is None
