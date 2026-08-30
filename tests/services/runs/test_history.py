import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.messages import (
    DocumentBlock,
    ProviderContinuationBlock,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
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
    session: AsyncSession,
    *,
    conversation_id: int,
    user_message_id: int,
    status: str = "queued",
    adapter: str = "fake",
    upstream: str = "fake-upstream",
    base_url: str = "https://fake.test/v1",
    provider_model: str = "fake-model",
    with_snapshot: bool = True,
) -> Run:
    run = Run(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        status=status,
        provider_name=adapter,
        provider_model=provider_model,
        model_config_snapshot=(
            {
                "version": 2,
                "catalog_model": "test-model",
                "route_id": 1,
                "upstream": upstream,
                "adapter": adapter,
                "base_url": base_url,
                "provider_model": provider_model,
                "thinking_levels": [],
                "reasoning_outputs": [],
                "supports_image_input": False,
                "image_token_reserve": None,
                "token_profile": "default",
            }
            if with_snapshot
            else None
        ),
    )
    session.add(run)
    await session.flush()
    return run


async def add_succeeded_tool_turn(
    session: AsyncSession,
    *,
    conversation_id: int,
    position: int,
    prompt: str,
    answer: str,
    marker: str,
    adapter: str = "openrouter",
    upstream: str = "openrouter",
    base_url: str = "https://openrouter.test/api/v1",
    provider_model: str = "x-ai/grok",
    user_blocks: list[dict[str, object]] | None = None,
    continuation_owner: str | None = "openrouter",
) -> tuple[Run, RunProviderMessage]:
    user_message = await add_message(
        session,
        conversation_id=conversation_id,
        role="user",
        content=prompt,
        position=position,
    )
    run = await create_run_for_message(
        session,
        conversation_id=conversation_id,
        user_message_id=user_message.id,
        status="succeeded",
        adapter=adapter,
        upstream=upstream,
        base_url=base_url,
        provider_model=provider_model,
    )
    user_message.run_id = run.id
    state_blocks: list[dict[str, object]] = [
        {"type": "reasoning", "kind": "raw", "text": f"reasoning-{marker}"},
    ]
    if continuation_owner is not None:
        state_blocks.append(
            {
                "type": "provider_continuation",
                "owner": continuation_owner,
                "codec": "reasoning_details.v1",
                "scope": "assistant_message",
                "payload": {
                    "reasoning_details": [
                        {"type": "reasoning.encrypted", "data": marker, "index": 0}
                    ]
                },
            }
        )
    state_blocks.append(
        {
            "type": "tool_call",
            "id": f"call-{marker}",
            "name": "search",
            "arguments": {"q": marker},
        }
    )
    state_row = RunProviderMessage(
        run_id=run.id,
        seq=2,
        role="assistant",
        blocks=state_blocks,
    )
    session.add_all(
        [
            RunProviderMessage(
                run_id=run.id,
                seq=1,
                message_id=user_message.id,
                role="user",
                blocks=user_blocks or [{"type": "text", "text": prompt}],
            ),
            state_row,
            RunProviderMessage(
                run_id=run.id,
                seq=3,
                role="user",
                blocks=[
                    {
                        "type": "tool_result",
                        "tool_call_id": f"call-{marker}",
                        "content": f"result-{marker}",
                        "is_error": False,
                    }
                ],
            ),
            RunProviderMessage(
                run_id=run.id,
                seq=4,
                role="assistant",
                blocks=[{"type": "text", "text": answer}],
            ),
        ]
    )
    assistant = await add_message(
        session,
        conversation_id=conversation_id,
        role="assistant",
        content=answer,
        position=position + 1,
    )
    assistant.run_id = run.id
    await session.flush()
    return run, state_row


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


async def test_self_contained_transcript_does_not_duplicate_materialized_assistant(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-document")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        first_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Read the attachment",
            position=1,
        )
        first_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=first_user.id,
        )
        first_run.status = "succeeded"
        first_user.run_id = first_run.id
        session.add_all(
            [
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=1,
                    message_id=first_user.id,
                    role="user",
                    blocks=[
                        {"type": "text", "text": "Read the attachment"},
                        {
                            "type": "document",
                            "file_id": str(uuid4()),
                            "filename": "facts.txt",
                            "media_type": "text/plain",
                            "text": "stable extracted facts",
                            "sha256": "a" * 64,
                            "extractor_version": "text-v1",
                            "warnings": [],
                            "summary": {"text_bytes": 22},
                        },
                    ],
                ),
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=2,
                    role="assistant",
                    blocks=[{"type": "text", "text": "I read the facts."}],
                ),
            ]
        )
        assistant = await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="I read the facts.",
            position=2,
        )
        assistant.run_id = first_run.id
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="What did it say?",
            position=3,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    assert [message.role for message in flat] == ["user", "assistant", "user"]
    document = flat[0].blocks[1]
    assert isinstance(document, DocumentBlock)
    assert document.text == "stable extracted facts"
    assert flat[1].text() == "I read the facts."


async def test_failed_run_keeps_exact_user_attachment_but_drops_partial_output(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-failed")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        first_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="",
            position=1,
        )
        first_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=first_user.id,
        )
        first_run.status = "failed"
        first_user.run_id = first_run.id
        session.add_all(
            [
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=1,
                    message_id=first_user.id,
                    role="user",
                    blocks=[
                        {
                            "type": "document",
                            "file_id": str(uuid4()),
                            "filename": "failed.txt",
                            "media_type": "text/plain",
                            "text": "input survives failure",
                            "sha256": "b" * 64,
                            "extractor_version": "text-v1",
                            "warnings": [],
                            "summary": {},
                        }
                    ],
                ),
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=2,
                    role="assistant",
                    blocks=[{"type": "text", "text": "partial answer must not replay"}],
                ),
            ]
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Try again",
            position=2,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    assert [message.role for message in flat] == ["user", "user"]
    document = flat[0].blocks[0]
    assert isinstance(document, DocumentBlock)
    assert document.text == "input survives failure"
    assert all("partial answer" not in message.text() for message in flat)


async def test_cross_model_history_is_projected_to_portable_turns_without_mutating_transcript(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    file_id = str(uuid4())
    persisted_blocks: list[dict[str, object]]
    async with session_factory() as session:
        user = await create_user(session, "hist-cross-model")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        _, state_row = await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=1,
            prompt="Read this",
            answer="Grok answer",
            marker="old-grok",
            provider_model="x-ai/grok",
            user_blocks=[
                {"type": "text", "text": "Read this"},
                {
                    "type": "document",
                    "file_id": file_id,
                    "filename": "facts.txt",
                    "media_type": "text/plain",
                    "text": "portable attachment facts",
                    "sha256": "c" * 64,
                    "extractor_version": "text-v1",
                    "warnings": [],
                    "summary": {},
                },
            ],
        )
        persisted_blocks = list(state_row.blocks or [])
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Ask Gemini",
            position=3,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
            adapter="openrouter",
            upstream="openrouter",
            base_url="https://openrouter.test/api/v1/",
            provider_model="google/gemini",
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)
        await session.refresh(state_row)

    assert [message.role for message in flat] == ["user", "assistant", "user"]
    assert flat[0].blocks[0] == TextBlock("Read this")
    document = flat[0].blocks[1]
    assert isinstance(document, DocumentBlock)
    assert document.text == "portable attachment facts"
    assert flat[1].blocks == [TextBlock("Grok answer")]
    assert flat[2].blocks == [TextBlock("Ask Gemini")]
    assert not any(
        isinstance(block, (ProviderContinuationBlock, ReasoningBlock, ToolCallBlock))
        for message in flat
        for block in message.blocks
    )
    assert not any(
        isinstance(block, ToolResultBlock) for message in flat for block in message.blocks
    )
    assert state_row.blocks == persisted_blocks


async def test_switching_back_starts_a_new_stage_without_resurrecting_old_state(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-switch-back")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=1,
            prompt="Grok one",
            answer="Grok one answer",
            marker="old-grok",
            provider_model="x-ai/grok",
        )
        await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=3,
            prompt="Gemini one",
            answer="Gemini answer",
            marker="gemini",
            provider_model="google/gemini",
        )
        await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=5,
            prompt="Grok two",
            answer="Grok two answer",
            marker="new-grok",
            provider_model="x-ai/grok",
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Grok three",
            position=7,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
            adapter="openrouter",
            upstream="openrouter",
            base_url="https://openrouter.test/api/v1",
            provider_model="x-ai/grok",
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    continuations = [
        block
        for message in flat
        for block in message.blocks
        if isinstance(block, ProviderContinuationBlock)
    ]
    assert len(continuations) == 1
    assert continuations[0].payload["reasoning_details"][0]["data"] == "new-grok"
    tool_calls = [
        block
        for message in flat
        for block in message.blocks
        if isinstance(block, ToolCallBlock)
    ]
    assert [block.id for block in tool_calls] == ["call-new-grok"]
    assert [message.text() for message in flat if message.role == "assistant"] == [
        "Grok one answer",
        "Gemini answer",
        "",
        "Grok two answer",
    ]


@pytest.mark.parametrize(
    ("target_adapter", "target_upstream", "target_base_url", "with_snapshot"),
    [
        ("deepseek", "openrouter", "https://openrouter.test/api/v1", True),
        ("openrouter", "second-openrouter", "https://openrouter.test/api/v1", True),
        ("openrouter", "openrouter", "https://other-openrouter.test/api/v1", True),
        ("openrouter", "openrouter", "https://openrouter.test/api/v1", False),
    ],
)
async def test_incompatible_or_unknown_route_affinity_uses_portable_projection(
    session_factory: async_sessionmaker[AsyncSession],
    target_adapter: str,
    target_upstream: str,
    target_base_url: str,
    with_snapshot: bool,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-route")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=1,
            prompt="First",
            answer="Portable answer",
            marker="foreign-state",
            provider_model="shared-model",
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Target",
            position=3,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
            adapter=target_adapter,
            upstream=target_upstream,
            base_url=target_base_url,
            provider_model="shared-model",
            with_snapshot=with_snapshot,
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    assert [message.text() for message in flat] == ["First", "Portable answer", "Target"]
    assert not any(
        isinstance(
            block,
            (ProviderContinuationBlock, ReasoningBlock, ToolCallBlock, ToolResultBlock),
        )
        for message in flat
        for block in message.blocks
    )


@pytest.mark.parametrize(
    ("source_adapter", "source_upstream", "target_adapter", "target_upstream", "full"),
    [
        ("deepseek", "deepseek-official", "deepseek", "deepseek-official", True),
        ("deepseek", "deepseek-official", "openrouter", "openrouter", False),
        ("openrouter", "openrouter", "deepseek", "deepseek-official", False),
    ],
)
async def test_deepseek_official_and_openrouter_have_distinct_continuation_stages(
    session_factory: async_sessionmaker[AsyncSession],
    source_adapter: str,
    source_upstream: str,
    target_adapter: str,
    target_upstream: str,
    full: bool,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-deepseek")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=1,
            prompt="DeepSeek prompt",
            answer="DeepSeek answer",
            marker="deepseek-state",
            adapter=source_adapter,
            upstream=source_upstream,
            base_url=(
                "https://api.deepseek.test/v1"
                if source_adapter == "deepseek"
                else "https://openrouter.test/api/v1"
            ),
            provider_model="deepseek-chat",
            continuation_owner=("openrouter" if source_adapter == "openrouter" else None),
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Follow up",
            position=3,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
            adapter=target_adapter,
            upstream=target_upstream,
            base_url=(
                "https://api.deepseek.test/v1/"
                if target_adapter == "deepseek"
                else "https://openrouter.test/api/v1"
            ),
            provider_model="deepseek-chat",
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    protocol_blocks = [
        block
        for message in flat
        for block in message.blocks
        if isinstance(block, (ProviderContinuationBlock, ReasoningBlock, ToolCallBlock))
    ]
    tool_results = [
        block
        for message in flat
        for block in message.blocks
        if isinstance(block, ToolResultBlock)
    ]
    if full:
        assert any(isinstance(block, ReasoningBlock) for block in protocol_blocks)
        assert any(isinstance(block, ToolCallBlock) for block in protocol_blocks)
        assert tool_results
    else:
        assert protocol_blocks == []
        assert tool_results == []


async def test_failed_incompatible_run_does_not_end_the_current_stage(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-fail-bar")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        await add_succeeded_tool_turn(
            session,
            conversation_id=conversation.id,
            position=1,
            prompt="Grok success",
            answer="Grok answer",
            marker="grok-state",
            provider_model="x-ai/grok",
        )
        failed_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Gemini failed",
            position=3,
        )
        failed_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=failed_user.id,
            status="failed",
            adapter="openrouter",
            upstream="openrouter",
            base_url="https://openrouter.test/api/v1",
            provider_model="google/gemini",
        )
        failed_user.run_id = failed_run.id
        session.add_all(
            [
                RunProviderMessage(
                    run_id=failed_run.id,
                    seq=1,
                    message_id=failed_user.id,
                    role="user",
                    blocks=[{"type": "text", "text": "Gemini failed"}],
                ),
                RunProviderMessage(
                    run_id=failed_run.id,
                    seq=2,
                    role="assistant",
                    blocks=[
                        {"type": "reasoning", "kind": "summary", "text": "partial"},
                        {"type": "text", "text": "must not replay"},
                    ],
                ),
            ]
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Grok retry",
            position=4,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
            adapter="openrouter",
            upstream="openrouter",
            base_url="https://openrouter.test/api/v1",
            provider_model="x-ai/grok",
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    continuations = [
        block
        for message in flat
        for block in message.blocks
        if isinstance(block, ProviderContinuationBlock)
    ]
    assert len(continuations) == 1
    assert continuations[0].payload["reasoning_details"][0]["data"] == "grok-state"
    assert all("must not replay" not in message.text() for message in flat)
    assert [message.text() for message in flat if message.role == "user"][-2:] == [
        "Gemini failed",
        "Grok retry",
    ]


async def test_portable_projection_omits_empty_final_assistant_turn(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "hist-empty")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()
        first_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="First",
            position=1,
        )
        first_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=first_user.id,
            status="succeeded",
            adapter="openrouter",
            upstream="openrouter",
            base_url="https://openrouter.test/api/v1",
            provider_model="x-ai/grok",
        )
        first_user.run_id = first_run.id
        session.add_all(
            [
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=1,
                    message_id=first_user.id,
                    role="user",
                    blocks=[{"type": "text", "text": "First"}],
                ),
                RunProviderMessage(
                    run_id=first_run.id,
                    seq=2,
                    role="assistant",
                    blocks=[{"type": "reasoning", "kind": "raw", "text": "only state"}],
                ),
            ]
        )
        empty_assistant = await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="",
            position=2,
        )
        empty_assistant.run_id = first_run.id
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="Target",
            position=3,
        )
        target_run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
            adapter="openrouter",
            upstream="openrouter",
            base_url="https://openrouter.test/api/v1",
            provider_model="google/gemini",
        )
        await session.commit()

        flat = await load_conversation_history(session, run_id=target_run.id)

    assert [message.role for message in flat] == ["user", "user"]
    assert [message.text() for message in flat] == ["First", "Target"]
