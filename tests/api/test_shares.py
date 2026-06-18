import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.conversation import Conversation, Message, ShareLink
from app.models.run import Run
from app.models.user import User

TEST_DATABASE_URL = os.environ.get(
    "CONVERSATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "share-api-test.example.com"


async def ready() -> bool:
    return True


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    await session.execute(delete(ShareLink).where(ShareLink.conversation_id.in_(conversation_ids)))
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


_SOURCES = [
    {
        "id": 1,
        "title": "Example",
        "url": "https://example.com",
        "snippet": "snip",
        "published_at": None,
        "provider": "tavily",
    }
]


async def seed_completed_turn(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_email: str,
) -> dict[str, Any]:
    """Insert a finished turn with reasoning + sources on the assistant reply."""
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
            reasoning="thinking...",
            metadata_={"sources": _SOURCES},
            position=2,
        )
        session.add(assistant_message)
        await session.commit()

        return {
            "conversation_id": str(conversation.public_id),
            "conversation_db_id": conversation.id,
        }


async def _create_share(
    client: AsyncClient,
    conversation_id: str,
    headers: dict[str, str],
    *,
    expires_in_days: int | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {}
    if expires_in_days is not None:
        body["expires_in_days"] = expires_in_days
    response = await client.post(
        f"/api/v1/conversations/{conversation_id}/shares",
        json=body,
        headers=headers,
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    return cast(dict[str, Any], response.json()["data"])


async def test_create_share_returns_token_and_public_read_serves_snapshot(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share",
        email=f"alice-share@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-share@{TEST_EMAIL_DOMAIN}"
    )

    created = await _create_share(client, seeded["conversation_id"], auth_headers(alice))
    assert created["token"]
    assert created["revoked_at"] is None
    assert created["expires_at"] is None

    # Anonymous read — no auth header.
    public = await client.get(f"/api/v1/share/{created['token']}")
    assert public.status_code == status.HTTP_200_OK
    data = public.json()["data"]
    assert data["title"] == "seeded"
    assert [m["role"] for m in data["messages"]] == ["user", "assistant"]
    assistant = data["messages"][1]
    assert assistant["content"] == "world"
    assert assistant["reasoning"] == "thinking..."
    assert assistant["sources"][0]["url"] == "https://example.com"
    # Snapshot must not leak internal ids or user identity.
    assert "id" not in data
    assert "conversation_id" not in assistant
    assert "created_by" not in data


async def test_list_shares_returns_only_the_active_link(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-list",
        email=f"alice-list@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-list@{TEST_EMAIL_DOMAIN}"
    )

    created = await _create_share(client, seeded["conversation_id"], headers)

    response = await client.get(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        headers=headers,
    )
    assert response.status_code == status.HTTP_200_OK
    data = response.json()["data"]
    assert [item["token"] for item in data] == [created["token"]]


async def test_create_second_share_conflicts_while_one_is_active(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-one",
        email=f"alice-one@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-one@{TEST_EMAIL_DOMAIN}"
    )

    await _create_share(client, seeded["conversation_id"], headers)
    conflict = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        json={},
        headers=headers,
    )
    assert conflict.status_code == status.HTTP_409_CONFLICT
    assert conflict.json() == {"detail": "Active share already exists"}


async def test_create_share_succeeds_after_revoking_previous(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-reissue",
        email=f"alice-reissue@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-reissue@{TEST_EMAIL_DOMAIN}"
    )

    first = await _create_share(client, seeded["conversation_id"], headers)
    revoke = await client.delete(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares/{first['token']}",
        headers=headers,
    )
    assert revoke.status_code == status.HTTP_200_OK

    # A new link can now be minted; the list shows only the new (active) one.
    second = await _create_share(client, seeded["conversation_id"], headers)
    assert second["token"] != first["token"]

    listing = await client.get(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        headers=headers,
    )
    assert [item["token"] for item in listing.json()["data"]] == [second["token"]]


async def test_revoked_share_returns_not_found_and_revoke_is_idempotent(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-revoke",
        email=f"alice-revoke@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-revoke@{TEST_EMAIL_DOMAIN}"
    )
    created = await _create_share(client, seeded["conversation_id"], headers)
    token = created["token"]

    revoke = await client.delete(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares/{token}",
        headers=headers,
    )
    assert revoke.status_code == status.HTTP_200_OK

    # Public read now 404s.
    public = await client.get(f"/api/v1/share/{token}")
    assert public.status_code == status.HTTP_404_NOT_FOUND
    assert public.json() == {"detail": "Share not found"}

    # Revoking again is idempotent.
    revoke_again = await client.delete(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares/{token}",
        headers=headers,
    )
    assert revoke_again.status_code == status.HTTP_200_OK

    # The revoked row is retained for audit but hidden from the owner's list.
    listing = await client.get(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        headers=headers,
    )
    assert listing.json()["data"] == []


async def test_expired_share_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-expire",
        email=f"alice-expire@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-expire@{TEST_EMAIL_DOMAIN}"
    )
    created = await _create_share(client, seeded["conversation_id"], headers)
    token = created["token"]

    # Force expiry into the past directly in the db.
    async with session_factory() as session:
        share = await session.scalar(select(ShareLink).where(ShareLink.token == token))
        assert share is not None
        share.expires_at = datetime.now(UTC) - timedelta(days=1)
        await session.commit()

    public = await client.get(f"/api/v1/share/{token}")
    assert public.status_code == status.HTTP_404_NOT_FOUND

    # The expired link is hidden from the owner's list, and no longer blocks a
    # new one (the at-most-one-active rule is time-aware).
    listing = await client.get(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        headers=headers,
    )
    assert listing.json()["data"] == []
    reissue = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        json={},
        headers=headers,
    )
    assert reissue.status_code == status.HTTP_201_CREATED


async def test_snapshot_is_frozen_against_later_edits(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-frozen",
        email=f"alice-frozen@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-frozen@{TEST_EMAIL_DOMAIN}"
    )
    created = await _create_share(client, seeded["conversation_id"], headers)
    token = created["token"]

    # Mutate the live conversation after the snapshot was taken.
    async with session_factory() as session:
        conversation = await session.get(Conversation, seeded["conversation_db_id"])
        assert conversation is not None
        conversation.title = "renamed after share"
        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == conversation.id)
            )
        ).all()
        for message in messages:
            message.content = "mutated"
        await session.commit()

    public = await client.get(f"/api/v1/share/{token}")
    data = public.json()["data"]
    assert data["title"] == "seeded"
    assert data["messages"][1]["content"] == "world"


async def test_unknown_token_returns_not_found(client: AsyncClient) -> None:
    response = await client.get("/api/v1/share/does-not-exist")
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Share not found"}


async def test_share_management_requires_authentication(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register_user(
        client,
        username="alice-share-auth",
        email=f"alice-auth@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-auth@{TEST_EMAIL_DOMAIN}"
    )
    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        json={},
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


async def test_cross_user_share_management_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-x",
        email=f"alice-x@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-share-x",
        email=f"bob-x@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(session_factory, user_email=f"alice-x@{TEST_EMAIL_DOMAIN}")
    # Alice owns a real share; Bob must not see or revoke it.
    created = await _create_share(client, seeded["conversation_id"], auth_headers(alice))

    create_as_bob = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        json={},
        headers=auth_headers(bob),
    )
    list_as_bob = await client.get(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        headers=auth_headers(bob),
    )
    revoke_as_bob = await client.delete(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares/{created['token']}",
        headers=auth_headers(bob),
    )
    assert create_as_bob.status_code == status.HTTP_404_NOT_FOUND
    assert list_as_bob.status_code == status.HTTP_404_NOT_FOUND
    assert revoke_as_bob.status_code == status.HTTP_404_NOT_FOUND


async def test_create_share_rejects_invalid_expiry(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-share-bad-expiry",
        email=f"alice-bad-expiry@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-bad-expiry@{TEST_EMAIL_DOMAIN}"
    )
    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/shares",
        json={"expires_in_days": 0},
        headers=auth_headers(alice),
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


async def test_create_share_on_missing_conversation_returns_not_found(
    client: AsyncClient,
) -> None:
    alice = await register_user(
        client,
        username="alice-share-missing",
        email=f"alice-missing@{TEST_EMAIL_DOMAIN}",
    )
    response = await client.post(
        f"/api/v1/conversations/{uuid.uuid4()}/shares",
        json={},
        headers=auth_headers(alice),
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND
