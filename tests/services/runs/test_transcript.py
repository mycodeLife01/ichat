import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.messages import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from app.models.conversation import Conversation
from app.models.conversation import Message as MessageRow
from app.models.run import Run, RunProviderMessage
from app.models.user import User
from app.services.runs.transcript import append_transcript_message, load_transcript

TEST_DATABASE_URL = os.environ.get(
    "TRANSCRIPT_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "transcript-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(
        delete(MessageRow).where(MessageRow.conversation_id.in_(conversation_ids))
    )
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


async def create_run(session: AsyncSession, name: str) -> Run:
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
    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()
    user_message = MessageRow(
        conversation_id=conversation.id,
        role="user",
        content="latest docs?",
        position=1,
    )
    session.add(user_message)
    await session.flush()
    run = Run(
        conversation_id=conversation.id,
        user_message_id=user_message.id,
        status="succeeded",
        provider_name="deepseek",
        provider_model="deepseek-chat",
    )
    session.add(run)
    await session.flush()
    return run


def transcript_messages() -> list[Message]:
    return [
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("Need current docs"),
                ToolCallBlock("call_1", "web_search", {"query": "docs"}),
                ToolCallBlock("call_2", "web_search", {"query": "release notes"}),
            ],
        ),
        Message(
            role="user",
            blocks=[
                ToolResultBlock("call_1", "Evidence [1]"),
                ToolResultBlock("call_2", "Search failed", is_error=True),
            ],
        ),
        Message(
            role="assistant",
            blocks=[ReasoningBlock("Use evidence"), TextBlock("Final answer [1]")],
        ),
    ]


async def test_new_transcript_rows_round_trip_blocks_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    expected = transcript_messages()
    async with session_factory() as session:
        run = await create_run(session, "blocks-round-trip")
        for message in expected:
            await append_transcript_message(
                session,
                run_id=run.id,
                message=message,
                count_tokens=len,
            )
        await session.commit()

        actual = await load_transcript(session, run_id=run.id)
        rows = (
            await session.scalars(
                select(RunProviderMessage)
                .where(RunProviderMessage.run_id == run.id)
                .order_by(RunProviderMessage.seq.asc())
            )
        ).all()

    assert actual == expected
    assert [row.role for row in rows] == ["assistant", "user", "assistant"]
    assert len(rows[1].blocks or []) == 2
    assert all(row.blocks is not None for row in rows)
    assert all(row.estimated_tokens > 0 for row in rows)
    assert all(
        row.content is None
        and row.reasoning_content is None
        and row.tool_call_id is None
        and row.tool_name is None
        and row.tool_calls is None
        and row.payload is None
        for row in rows
    )


async def test_legacy_wire_rows_and_new_blocks_have_equivalent_semantics(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    expected = [
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("Need current docs"),
                ToolCallBlock("call_1", "web_search", {"query": "docs"}),
            ],
        ),
        Message(role="user", blocks=[ToolResultBlock("call_1", "Evidence [1]")]),
        Message(
            role="assistant",
            blocks=[ReasoningBlock("Use evidence"), TextBlock("Final answer [1]")],
        ),
    ]
    async with session_factory() as session:
        legacy_run = await create_run(session, "legacy-wire")
        new_run = await create_run(session, "new-blocks")
        session.add_all(
            [
                RunProviderMessage(
                    run_id=legacy_run.id,
                    seq=1,
                    role="assistant",
                    reasoning_content="Need current docs",
                    tool_calls=[
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "web_search",
                                "arguments": '{"query":"docs"}',
                            },
                        }
                    ],
                ),
                RunProviderMessage(
                    run_id=legacy_run.id,
                    seq=2,
                    role="tool",
                    content="Evidence [1]",
                    tool_call_id="call_1",
                    tool_name="web_search",
                ),
                RunProviderMessage(
                    run_id=legacy_run.id,
                    seq=3,
                    role="assistant",
                    content="Final answer [1]",
                    reasoning_content="Use evidence",
                ),
            ]
        )
        for message in expected:
            await append_transcript_message(session, run_id=new_run.id, message=message)
        await session.commit()

        legacy = await load_transcript(session, run_id=legacy_run.id)
        new = await load_transcript(session, run_id=new_run.id)

    assert legacy == expected
    assert new == expected
