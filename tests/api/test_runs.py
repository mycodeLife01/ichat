import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from typing import Any, cast

import pytest
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.session import get_session
from app.main import create_app
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.runs.service import append_run_event

TEST_DATABASE_URL = os.environ.get(
    "RUN_API_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "runs-api-test.example.com"


async def ready() -> bool:
    return True


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
async def app(session_factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[FastAPI]:
    app = create_app(database_ready_check=ready)

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    yield app
    app.dependency_overrides.clear()


@pytest.fixture()
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


async def register_user(
    client: AsyncClient,
    *,
    username: str,
    email: str,
) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "email": email, "password": "correct-password"},
    )
    assert response.status_code == status.HTTP_201_CREATED
    return cast(dict[str, Any], response.json()["data"])


def auth_headers(token_data: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {token_data['access_token']}"}


async def create_run_for_user(
    session: AsyncSession,
    *,
    user_id: int,
    status_value: str = "streaming",
) -> Run:
    conversation = Conversation(user_id=user_id, title="Run chat")
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
    return run


async def test_get_run_state_returns_current_draft(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-run-state-api",
        email=f"alice-state@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="streaming",
        )
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
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/state", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {
        "run_id": run_id,
        "status": "streaming",
        "latest_seq": 3,
        "draft_text": "Hello world",
        "terminal_event": None,
    }


async def test_run_state_requires_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/v1/runs/1/state")

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json() == {"detail": "Authentication required"}


async def test_cross_user_run_state_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-private-run-api",
        email=f"alice-private@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-private-run-api",
        email=f"bob-private@{TEST_EMAIL_DOMAIN}",
    )
    bob_headers = auth_headers(bob)

    async with session_factory() as session:
        run = await create_run_for_user(session, user_id=alice["user"]["id"])
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/state", headers=bob_headers)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Run not found"}


async def test_run_events_replay_starts_after_seq_and_stops_at_terminal(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-run-events-api",
        email=f"alice-events@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="succeeded",
        )
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/events?after_seq=1", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert "id: 1" not in body
    assert "event: run_started" not in body
    assert "id: 2" in body
    assert "event: text_delta" in body
    assert '"payload":{"text":"Hello"}' in body
    assert "id: 3" in body
    assert "event: run_succeeded" in body


async def test_run_events_returns_empty_stream_when_after_seq_passed_terminal(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-terminal-passed-api",
        email=f"alice-terminal-passed@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="succeeded",
        )
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/events?after_seq=2", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.text == ""


async def test_run_events_rejects_negative_after_seq(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-run-events-invalid-api",
        email=f"alice-events-invalid@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    response = await client.get("/api/v1/runs/1/events?after_seq=-1", headers=headers)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


async def test_cross_user_run_events_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-private-events-api",
        email=f"alice-private-events@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-private-events-api",
        email=f"bob-private-events@{TEST_EMAIL_DOMAIN}",
    )
    bob_headers = auth_headers(bob)

    async with session_factory() as session:
        run = await create_run_for_user(session, user_id=alice["user"]["id"])
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/events", headers=bob_headers)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Run not found"}


async def test_run_events_tails_new_persisted_events_until_terminal(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-tail-events-api",
        email=f"alice-tail-events@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="streaming",
        )
        run_id = run.id
        await session.commit()

    response_task = asyncio.create_task(
        client.get(f"/api/v1/runs/{run_id}/events?after_seq=0", headers=headers, timeout=3.0)
    )

    try:
        await asyncio.sleep(0.3)
        assert not response_task.done()

        async with session_factory() as session:
            await append_run_event(
                session,
                run_id=run_id,
                event_type="text_delta",
                payload={"text": "Late hello"},
            )
            await append_run_event(session, run_id=run_id, event_type="run_succeeded", payload={})
            await session.commit()

        response = await asyncio.wait_for(response_task, timeout=3.0)
    finally:
        if not response_task.done():
            response_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await response_task

    assert response.status_code == status.HTTP_200_OK
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert "id: 1" in body
    assert "id: 2" in body
    assert "event: text_delta" in body
    assert '"payload":{"text":"Late hello"}' in body
    assert "event: run_succeeded" in body
    assert '"seq":2,"type":"run_succeeded","payload":{}' in body
    assert body.index("event: text_delta") < body.index("event: run_succeeded")
