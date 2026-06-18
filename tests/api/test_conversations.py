import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.models.user import User

TEST_DATABASE_URL = os.environ.get(
    "CONVERSATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "conversation-api-test.example.com"


async def ready() -> bool:
    return True


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


@pytest.fixture()
async def app(session_factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[FastAPI]:
    get_settings.cache_clear()
    app = create_app(database_ready_check=ready)

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    yield app
    app.dependency_overrides.clear()
    get_settings.cache_clear()


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


async def test_conversation_crud_flow(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-conversation-api",
        email=f"alice@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    create_response = await client.post(
        "/api/v1/conversations",
        json={"title": "  Project chat  "},
        headers=headers,
    )
    list_response = await client.get("/api/v1/conversations", headers=headers)

    assert create_response.status_code == status.HTTP_201_CREATED
    created = create_response.json()["data"]
    assert created["title"] == "Project chat"
    assert created["activated_at"] is None
    assert set(created) == {"id", "title", "activated_at", "created_at", "updated_at"}
    assert list_response.status_code == status.HTTP_200_OK
    assert list_response.json()["data"] == []

    detail_response = await client.get(f"/api/v1/conversations/{created['id']}", headers=headers)
    rename_response = await client.patch(
        f"/api/v1/conversations/{created['id']}",
        json={"title": "Renamed"},
        headers=headers,
    )
    delete_response = await client.delete(
        f"/api/v1/conversations/{created['id']}",
        headers=headers,
    )
    missing_after_delete_response = await client.get(
        f"/api/v1/conversations/{created['id']}",
        headers=headers,
    )

    assert detail_response.status_code == status.HTTP_200_OK
    assert detail_response.json()["data"]["messages"] == []
    assert rename_response.status_code == status.HTTP_200_OK
    assert rename_response.json()["data"]["title"] == "Renamed"
    assert delete_response.status_code == status.HTTP_200_OK
    assert delete_response.json() == {"data": {"status": "ok"}}
    assert missing_after_delete_response.status_code == status.HTTP_404_NOT_FOUND
    assert missing_after_delete_response.json() == {"detail": "Conversation not found"}


async def test_rename_draft_does_not_make_it_visible(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-draft-rename-api",
        email=f"alice-draft-rename@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]
    rename_response = await client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "Draft title"},
        headers=headers,
    )
    list_response = await client.get("/api/v1/conversations", headers=headers)
    detail_response = await client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)

    assert rename_response.status_code == status.HTTP_200_OK
    assert rename_response.json()["data"]["title"] == "Draft title"
    assert rename_response.json()["data"]["activated_at"] is None
    assert list_response.status_code == status.HTTP_200_OK
    assert list_response.json()["data"] == []
    assert detail_response.status_code == status.HTTP_200_OK
    assert detail_response.json()["data"]["title"] == "Draft title"
    assert detail_response.json()["data"]["activated_at"] is None


async def test_send_message_creates_user_message_and_queued_run(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-message-api",
        email=f"alice-message@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]

    message_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Hello"},
        headers=headers,
    )
    second_message_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Again"},
        headers=headers,
    )
    detail_response = await client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)

    assert message_response.status_code == status.HTTP_201_CREATED
    data = message_response.json()["data"]
    assert data["message"]["role"] == "user"
    assert data["message"]["content"] == "Hello"
    assert data["message"]["position"] == 1
    assert data["message"]["run_id"] == data["run"]["id"]
    assert data["run"]["status"] == "queued"
    assert data["run"]["provider_name"] == "deepseek"
    assert data["run"]["provider_model"] == "deepseek-test"
    assert second_message_response.status_code == status.HTTP_409_CONFLICT
    assert second_message_response.json() == {"detail": "Active run already exists"}
    assert detail_response.json()["data"]["messages"][0]["content"] == "Hello"

    async with session_factory() as session:
        run = await session.scalar(
            select(Run).where(Run.public_id == uuid.UUID(data["run"]["id"]))
        )
        assert run is not None
        # No per-request override → env defaults resolved at creation time
        # (conftest sets DEEPSEEK_THINKING_ENABLED=false, effort default high).
        assert run.provider_options == {
            "thinking_enabled": False,
            "reasoning_effort": "high",
            "web_search_enabled": False,
            "web_search_suppressed_by_user": False,
        }
        # The faithful prompt snapshot is written by the worker at execution
        # time (it depends on the final web-search decision and date), so a
        # freshly queued run has none yet.
        assert run.system_prompt_snapshot is None


async def test_send_message_with_thinking_override_persists_provider_options(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-thinking-api",
        email=f"alice-thinking@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]

    message_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Hello", "thinking_enabled": True, "reasoning_effort": "max"},
        headers=headers,
    )

    assert message_response.status_code == status.HTTP_201_CREATED
    run_id = message_response.json()["data"]["run"]["id"]
    async with session_factory() as session:
        run = await session.scalar(select(Run).where(Run.public_id == uuid.UUID(run_id)))
        assert run is not None
        assert run.provider_options == {
            "thinking_enabled": True,
            "reasoning_effort": "max",
            "web_search_enabled": False,
            "web_search_suppressed_by_user": False,
        }


async def test_send_message_rejects_invalid_reasoning_effort(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-bad-effort",
        email=f"alice-bad-effort@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]

    response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Hello", "thinking_enabled": True, "reasoning_effort": "turbo"},
        headers=headers,
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


async def test_conversation_routes_require_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/v1/conversations")

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json() == {"detail": "Authentication required"}


async def test_cross_user_conversation_access_returns_not_found(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-private-api",
        email=f"alice-private@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-private-api",
        email=f"bob-private@{TEST_EMAIL_DOMAIN}",
    )
    alice_headers = auth_headers(alice)
    bob_headers = auth_headers(bob)
    create_response = await client.post(
        "/api/v1/conversations",
        json={"title": "Private"},
        headers=alice_headers,
    )
    conversation_id = create_response.json()["data"]["id"]

    get_response = await client.get(f"/api/v1/conversations/{conversation_id}", headers=bob_headers)
    patch_response = await client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "Nope"},
        headers=bob_headers,
    )
    send_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Nope"},
        headers=bob_headers,
    )

    assert get_response.status_code == status.HTTP_404_NOT_FOUND
    assert patch_response.status_code == status.HTTP_404_NOT_FOUND
    assert send_response.status_code == status.HTTP_404_NOT_FOUND


async def seed_completed_turn(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_email: str,
) -> dict[str, Any]:
    """Insert a finished turn (user + assistant + succeeded run) for the user.

    Returns the public ids (for URLs/response comparison) and internal db ids
    (for direct ORM lookups) of conversation, user_message, assistant_message.
    """
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == user_email))
        assert user is not None, "register_user must run before seed_completed_turn"
        conversation = Conversation(user_id=user.id, title="seeded", activated_at=datetime.now(UTC))
        session.add(conversation)
        await session.flush()

        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content="hello",
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
        user_message.run_id = run.id

        assistant_message = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content="world",
            position=2,
        )
        session.add(assistant_message)
        await session.commit()

        return {
            "conversation_id": str(conversation.public_id),
            "user_message_id": str(user_message.public_id),
            "assistant_message_id": str(assistant_message.public_id),
            "conversation_db_id": conversation.id,
            "user_message_db_id": user_message.id,
            "assistant_message_db_id": assistant_message.id,
        }


async def test_edit_and_regenerate_endpoint_creates_new_message_and_run(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-edit-regen",
        email=f"alice-edit@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-edit@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['user_message_id']}/edit-and-regenerate",
        json={"content": "rewritten"},
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()["data"]
    assert body["message"]["role"] == "user"
    assert body["message"]["content"] == "rewritten"
    assert body["message"]["id"] != seeded["user_message_id"]
    assert body["run"]["status"] == "queued"

    async with session_factory() as session:
        old_user = await session.get(Message, seeded["user_message_db_id"])
        old_assistant = await session.get(Message, seeded["assistant_message_db_id"])
        assert old_user is not None and old_user.archived_at is not None
        assert old_assistant is not None and old_assistant.archived_at is not None


async def test_regenerate_endpoint_reuses_user_message_for_assistant_target(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-regen",
        email=f"alice-regen@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-regen@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['assistant_message_id']}/regenerate",
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()["data"]
    assert body["message"]["id"] == seeded["user_message_id"]
    assert body["run"]["status"] == "queued"
    assert body["run"]["user_message_id"] == seeded["user_message_id"]

    async with session_factory() as session:
        anchor = await session.get(Message, seeded["user_message_db_id"])
        archived_assistant = await session.get(Message, seeded["assistant_message_db_id"])
        assert anchor is not None and anchor.archived_at is None
        assert archived_assistant is not None and archived_assistant.archived_at is not None


async def test_regenerate_endpoint_accepts_thinking_options_body(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-regen-thinking",
        email=f"alice-regen-thinking@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-regen-thinking@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['assistant_message_id']}/regenerate",
        json={"thinking_enabled": True, "reasoning_effort": "high"},
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_201_CREATED
    run_id = response.json()["data"]["run"]["id"]
    async with session_factory() as session:
        run = await session.scalar(select(Run).where(Run.public_id == uuid.UUID(run_id)))
        assert run is not None
        assert run.provider_options == {
            "thinking_enabled": True,
            "reasoning_effort": "high",
            "web_search_enabled": False,
            "web_search_suppressed_by_user": False,
        }


async def test_send_message_suppresses_web_search_when_user_says_not_to_search(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEB_SEARCH_ENABLED", "true")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    get_settings.cache_clear()
    alice = await register_user(
        client,
        username="alice-no-search-api",
        email=f"alice-no-search@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]

    response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "不要联网，解释一下递归", "web_search_enabled": True},
        headers=headers,
    )

    assert response.status_code == status.HTTP_201_CREATED
    run_id = response.json()["data"]["run"]["id"]
    async with session_factory() as session:
        run = await session.scalar(select(Run).where(Run.public_id == uuid.UUID(run_id)))
        assert run is not None
        assert run.provider_options is not None
        assert run.provider_options["web_search_enabled"] is False
        assert run.provider_options["web_search_suppressed_by_user"] is True


async def test_capabilities_endpoint_is_public_and_hides_provider_name(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEB_SEARCH_ENABLED", "true")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    get_settings.cache_clear()

    response = await client.get("/api/v1/capabilities")

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {"web_search": {"enabled": True}}


async def test_edit_and_regenerate_rejects_cross_user(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register_user(
        client,
        username="alice-cross",
        email=f"alice-cross@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-cross",
        email=f"bob-cross@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-cross@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['user_message_id']}/edit-and-regenerate",
        json={"content": "intrusion"},
        headers=auth_headers(bob),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


async def test_regenerate_endpoint_conflicts_with_active_run(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-active",
        email=f"alice-active@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-active@{TEST_EMAIL_DOMAIN}"
    )

    async with session_factory() as session:
        session.add(
            Run(
                conversation_id=seeded["conversation_db_id"],
                user_message_id=seeded["user_message_db_id"],
                status="queued",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )
        )
        await session.commit()

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['assistant_message_id']}/regenerate",
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["detail"] == "Active run already exists"
