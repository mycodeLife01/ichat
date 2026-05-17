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
    assert set(created) == {"id", "title", "created_at", "updated_at"}
    assert list_response.status_code == status.HTTP_200_OK
    assert [item["id"] for item in list_response.json()["data"]] == [created["id"]]

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


async def test_send_message_creates_user_message_and_queued_run(client: AsyncClient) -> None:
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
