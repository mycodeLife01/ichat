import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.schemas.runs import RunEventType
from app.services.runs.service import (
    append_run_event,
    cancel_owned_run,
    get_owned_run_state,
    get_owned_visible_run,
    list_owned_run_events_after,
    run_has_terminal_event,
)

TEST_DATABASE_URL = os.environ.get(
    "RUN_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "runs-service-test.example.com"


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


async def create_user(session: AsyncSession, username: str) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{username}-{suffix}",
        email=f"{username}-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def create_run(
    session: AsyncSession,
    *,
    user: User,
    status_value: str = "streaming",
) -> tuple[Conversation, Message, Run]:
    conversation = Conversation(user_id=user.id, title="Run chat")
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
        status=status_value,
        provider_name="deepseek",
        provider_model="deepseek-chat",
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    await session.flush()
    return conversation, message, run


async def test_append_run_event_assigns_monotonic_seq(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user)

        started = await append_run_event(
            session,
            run_id=run.id,
            event_type="run_started",
            payload={},
        )
        delta = await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await session.commit()

        stored_events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.seq.asc())
            )
        ).all()

    assert started.seq == 1
    assert delta.seq == 2
    assert [event.seq for event in stored_events] == [1, 2]
    assert stored_events[1].payload == {"text": "Hello"}


async def test_list_owned_run_events_after_filters_by_seq(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user)
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(
            session,
            run_id=run.id,
            event_type="run_succeeded",
            payload={},
        )

        events = await list_owned_run_events_after(
            session,
            user=user,
            run_public_id=run.public_id,
            after_seq=1,
        )

    assert [event.seq for event in events] == [2, 3]
    assert [event.type for event in events] == ["text_delta", "run_succeeded"]


async def test_get_owned_run_state_builds_draft_from_text_delta_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="succeeded")
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": " world"},
        )
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})

        state = await get_owned_run_state(session, user=user, run_public_id=run.public_id)

    assert state.run_id == run.public_id
    assert state.status == "succeeded"
    assert state.latest_seq == 4
    assert state.draft_text == "Hello world"
    assert state.terminal_event is not None
    assert state.terminal_event.type == "run_succeeded"


async def test_run_has_terminal_event_detects_terminal_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user)

        before = await run_has_terminal_event(session, run_id=run.id)
        await append_run_event(session, run_id=run.id, event_type="run_failed", payload={})
        after = await run_has_terminal_event(session, run_id=run.id)

    assert before is False
    assert after is True


async def test_cross_user_run_access_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        other_user = await create_user(session, "bob")
        _, _, run = await create_run(session, user=owner)

        with pytest.raises(AppError) as exc_info:
            await get_owned_visible_run(session, user=other_user, run_public_id=run.public_id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"


async def test_deleted_conversation_run_access_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, _, run = await create_run(session, user=user)
        conversation.deleted_at = datetime.now(UTC)
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await get_owned_run_state(session, user=user, run_public_id=run.public_id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"


async def test_cancel_owned_queued_run_marks_cancelled_and_writes_terminal_event(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="queued")
        run.lease_owner = "stale-worker"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        run_id = run.id
        result = await cancel_owned_run(session, user=user, run_public_id=run.public_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelled"
        assert updated.cancelled_at is not None
        assert updated.completed_at is not None
        assert updated.lease_owner is None
        assert updated.lease_expires_at is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [(event.seq, event.type, event.payload) for event in events] == [
            (1, "run_cancelled", {})
        ]


@pytest.mark.parametrize("active_status", ["started", "streaming"])
async def test_cancel_owned_active_run_marks_cancelling_without_terminal_event(
    session_factory: async_sessionmaker[AsyncSession],
    active_status: str,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value=active_status)
        run_id = run.id
        await append_run_event(session, run_id=run_id, event_type="run_started", payload={})
        result = await cancel_owned_run(session, user=user, run_public_id=run.public_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelling"
        assert updated.cancelled_at is None
        assert updated.completed_at is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == ["run_started"]


@pytest.mark.parametrize(
    ("terminal_status", "event_type"),
    [
        ("succeeded", "run_succeeded"),
        ("failed", "run_failed"),
        ("cancelled", "run_cancelled"),
    ],
)
async def test_cancel_owned_terminal_run_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
    terminal_status: str,
    event_type: RunEventType,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value=terminal_status)
        run_id = run.id
        await append_run_event(session, run_id=run_id, event_type=event_type, payload={})
        result = await cancel_owned_run(session, user=user, run_public_id=run.public_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == terminal_status

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == [event_type]


async def test_cancel_owned_cancelling_run_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="cancelling")
        run_id = run.id
        result = await cancel_owned_run(session, user=user, run_public_id=run.public_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelling"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events == []


async def test_cancel_owned_run_cross_user_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        other_user = await create_user(session, "bob")
        _, _, run = await create_run(session, user=owner, status_value="streaming")

        with pytest.raises(AppError) as exc_info:
            await cancel_owned_run(session, user=other_user, run_public_id=run.public_id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"


async def test_get_owned_run_state_builds_draft_reasoning_from_reasoning_delta_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="succeeded")
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session, run_id=run.id, event_type="reasoning_delta", payload={"text": "think "}
        )
        await append_run_event(
            session, run_id=run.id, event_type="reasoning_delta", payload={"text": "more"}
        )
        await append_run_event(
            session, run_id=run.id, event_type="text_delta", payload={"text": "answer"}
        )
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})

        state = await get_owned_run_state(session, user=user, run_public_id=run.public_id)

    assert state.draft_text == "answer"
    assert state.draft_reasoning == "think more"


async def test_cancel_owned_run_deleted_conversation_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, _, run = await create_run(session, user=user, status_value="streaming")
        conversation.deleted_at = datetime.now(UTC)
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await cancel_owned_run(session, user=user, run_public_id=run.public_id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"
