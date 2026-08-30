from collections.abc import AsyncIterator

import fakeredis.aioredis
import pytest
from fastapi import status
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.model_catalog import ChatModel, ModelRoute, ModelUpstream
from app.services.auth import rate_limit
from app.services.model_catalog import management
from app.services.model_catalog.management import CatalogInventory
from app.services.model_catalog.service import ModelCatalogError

ACCESS_KEY = "model-management-test-key-with-32-characters"


class FakeSession:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        self.rollbacks += 1


def catalog_inventory() -> CatalogInventory:
    model = ChatModel(
        id=1,
        key="deepseek-v4",
        label="DeepSeek V4",
        thinking_levels=["low", "high", "max"],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="deepseek",
        sort_order=0,
        enabled=True,
    )
    upstream = ModelUpstream(
        id=2,
        key="openrouter",
        label="OpenRouter",
        adapter="openrouter",
        base_url="https://openrouter.example/api/v1",
        api_key_ciphertext="fernet:v1:never-return-this-ciphertext",
        api_key_hint="…cret",
        enabled=True,
    )
    route = ModelRoute(
        id=3,
        chat_model_id=1,
        upstream_id=2,
        upstream_model="deepseek/deepseek-v4",
        reasoning_outputs=["raw", "summary"],
        priority=10,
        enabled=True,
    )
    return CatalogInventory(
        database_enabled=True,
        models=(model,),
        upstreams=(upstream,),
        routes=(route,),
        selected_route_ids=frozenset({3}),
    )


@pytest.fixture()
def admin_client(monkeypatch: MonkeyPatch) -> tuple[TestClient, FakeSession]:
    session = FakeSession()
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    settings = get_settings().model_copy(
        update={
            "model_admin_access_key": ACCESS_KEY,
            "model_catalog_encryption_key": "unused-by-these-api-tests",
        }
    )

    async def session_dependency() -> AsyncIterator[FakeSession]:
        yield session

    async def inventory_dependency(_session: object) -> CatalogInventory:
        return catalog_inventory()

    monkeypatch.setattr(management, "catalog_inventory", inventory_dependency)
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_session] = session_dependency
    app.dependency_overrides[rate_limit.get_redis] = lambda: redis
    return TestClient(app), session


def test_model_admin_rejects_missing_key_and_user_bearer_token(
    admin_client: tuple[TestClient, FakeSession],
) -> None:
    client, _session = admin_client

    missing = client.get("/api/v1/model-admin")
    bearer_only = client.get(
        "/api/v1/model-admin",
        headers={"Authorization": "Bearer ordinary-user-token"},
    )

    assert missing.status_code == status.HTTP_401_UNAUTHORIZED
    assert bearer_only.status_code == status.HTTP_401_UNAUTHORIZED
    assert missing.json() == {"detail": "Invalid model management access key"}
    assert bearer_only.json() == missing.json()


def test_model_admin_returns_inventory_without_credentials(
    admin_client: tuple[TestClient, FakeSession],
) -> None:
    client, _session = admin_client

    response = client.get(
        "/api/v1/model-admin",
        headers={"X-Model-Admin-Key": ACCESS_KEY},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {
        "data": {
            "database_enabled": True,
            "models": [
                {
                    "key": "deepseek-v4",
                    "label": "DeepSeek V4",
                    "thinking_levels": ["low", "high", "max"],
                    "supports_image_input": False,
                    "image_token_reserve": None,
                    "token_profile": "deepseek",
                    "sort_order": 0,
                    "enabled": True,
                }
            ],
            "upstreams": [
                {
                    "key": "openrouter",
                    "label": "OpenRouter",
                    "adapter": "openrouter",
                    "base_url": "https://openrouter.example/api/v1",
                    "api_key_hint": "…cret",
                    "enabled": True,
                }
            ],
            "routes": [
                {
                    "model_key": "deepseek-v4",
                    "upstream_key": "openrouter",
                    "upstream_model": "deepseek/deepseek-v4",
                    "reasoning_outputs": ["raw", "summary"],
                    "priority": 10,
                    "enabled": True,
                    "selected": True,
                }
            ],
        }
    }
    response_text = response.text
    assert ACCESS_KEY not in response_text
    assert "never-return-this-ciphertext" not in response_text


def test_model_admin_updates_model_and_commits(
    admin_client: tuple[TestClient, FakeSession],
    monkeypatch: MonkeyPatch,
) -> None:
    client, session = admin_client
    captured: dict[str, object] = {}

    async def upsert(_session: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(management, "upsert_chat_model", upsert)

    response = client.put(
        "/api/v1/model-admin/models/deepseek-v4",
        headers={"X-Model-Admin-Key": ACCESS_KEY},
        json={
            "label": "DeepSeek V4 Updated",
            "thinking_levels": ["high", "max"],
            "supports_image_input": False,
            "image_token_reserve": None,
            "token_profile": "deepseek",
            "sort_order": 2,
            "enabled": True,
        },
    )

    assert response.status_code == status.HTTP_200_OK
    assert session.commits == 1
    assert session.rollbacks == 0
    assert captured["key"] == "deepseek-v4"
    assert captured["label"] == "DeepSeek V4 Updated"
    assert captured["thinking_levels"] == ["high", "max"]


def test_model_admin_updates_route_reasoning_outputs_and_commits(
    admin_client: tuple[TestClient, FakeSession],
    monkeypatch: MonkeyPatch,
) -> None:
    client, session = admin_client
    captured: dict[str, object] = {}

    async def upsert(_session: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(management, "upsert_model_route", upsert)

    response = client.put(
        "/api/v1/model-admin/routes",
        headers={"X-Model-Admin-Key": ACCESS_KEY},
        json={
            "model_key": "deepseek-v4",
            "upstream_key": "openrouter",
            "upstream_model": "deepseek/deepseek-v4",
            "reasoning_outputs": ["raw", "summary"],
            "priority": 10,
            "enabled": True,
        },
    )

    assert response.status_code == status.HTTP_200_OK
    assert session.commits == 1
    assert captured["reasoning_outputs"] == ["raw", "summary"]


def test_model_admin_maps_catalog_validation_to_422_and_rolls_back(
    admin_client: tuple[TestClient, FakeSession],
    monkeypatch: MonkeyPatch,
) -> None:
    client, session = admin_client

    async def reject(_session: object, **_kwargs: object) -> object:
        raise ModelCatalogError("Route is incompatible with this adapter")

    monkeypatch.setattr(management, "upsert_model_route", reject)

    response = client.put(
        "/api/v1/model-admin/routes",
        headers={"X-Model-Admin-Key": ACCESS_KEY},
        json={
            "model_key": "deepseek-v4",
            "upstream_key": "openrouter",
            "upstream_model": "deepseek/deepseek-v4",
            "priority": 10,
            "enabled": True,
        },
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json() == {"detail": "Route is incompatible with this adapter"}
    assert session.commits == 0
    assert session.rollbacks == 1


def test_model_admin_rate_limits_repeated_invalid_keys(
    admin_client: tuple[TestClient, FakeSession],
) -> None:
    client, _session = admin_client

    responses = [
        client.get(
            "/api/v1/model-admin",
            headers={"X-Model-Admin-Key": f"wrong-key-{attempt}"},
        )
        for attempt in range(11)
    ]

    assert all(response.status_code == status.HTTP_401_UNAUTHORIZED for response in responses[:10])
    assert responses[10].status_code == status.HTTP_429_TOO_MANY_REQUESTS
    assert int(responses[10].headers["Retry-After"]) > 0
