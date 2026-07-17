import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.messages import ReasoningBlock, TextBlock, ToolCallBlock, ToolResultBlock
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunProviderMessage
from app.models.user import User
from app.services.runs.history import load_conversation_history

TEST_DATABASE_URL = os.environ.get(
    "CONTEXT_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "history-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
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


async def create_user(session: AsyncSession, name: str) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{name}-{suffix}",
        email=f"{name}-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def add_message(
    session: AsyncSession,
    *,
    conversation_id: int,
    role: str,
    content: str,
    position: int,
) -> Message:
    message = Message(
        conversation_id=conversation_id, role=role, content=content, position=position
    )
    session.add(message)
    await session.flush()
    return message


async def create_run_for_message(
    session: AsyncSession, *, conversation_id: int, user_message_id: int
) -> Run:
    run = Run(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        status="queued",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    return run


async def test_load_turns_up_to_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session, conversation_id=conversation.id, role="user", content="first user", position=1
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="first assistant",
            position=2,
        )
        target_user = await add_message(
            session, conversation_id=conversation.id, role="user", content="second user", position=3
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="future (excluded)",
            position=4,
        )
        run = await create_run_for_message(
            session, conversation_id=conversation.id, user_message_id=target_user.id
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=run.id)
    assert [m.role for m in flat] == ["user", "assistant", "user"]
    assert [m.text() for m in flat] == ["first user", "first assistant", "second user"]


async def test_load_turns_raises_when_run_missing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        with pytest.raises(LookupError):
            await load_conversation_history(session, run_id=999_999_999)


async def test_load_turns_replays_transcript_as_blocks(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-transcript")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        first_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="latest docs?",
            position=1,
        )
        first_run = await create_run_for_message(
            session, conversation_id=conversation.id, user_message_id=first_user.id
        )
        first_run.status = "succeeded"
        first_user.run_id = first_run.id
        await session.flush()
        session.add_all(
            [
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=1,
                    role="assistant",
                    reasoning_content="Need current docs",
                    tool_calls=[
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "web_search",
                                "arguments": '{"query":"latest docs"}',
                            },
                        }
                    ],
                ),
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=2,
                    role="tool",
                    content="Evidence [1]",
                    tool_call_id="call_1",
                    tool_name="web_search",
                ),
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=3,
                    role="assistant",
                    content="Final answer [1]",
                    reasoning_content="Use evidence",
                ),
            ]
        )
        target_user = await add_message(
            session, conversation_id=conversation.id, role="user", content="follow up", position=2
        )
        target_run = await create_run_for_message(
            session, conversation_id=conversation.id, user_message_id=target_user.id
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)
    assert [m.role for m in flat] == ["user", "assistant", "user", "assistant", "user"]
    tool_turn = flat[1]
    assert tool_turn.blocks[0] == ReasoningBlock("Need current docs")
    tool_call = tool_turn.blocks[1]
    assert isinstance(tool_call, ToolCallBlock)
    assert tool_call.id == "call_1"
    assert tool_call.arguments == {"query": "latest docs"}
    assert flat[2].blocks == [ToolResultBlock("call_1", "Evidence [1]")]
    assert flat[3].blocks == [ReasoningBlock("Use evidence"), TextBlock("Final answer [1]")]
    assert flat[-1].text() == "follow up"
