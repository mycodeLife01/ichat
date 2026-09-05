from httpx import ASGITransport, AsyncClient

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.services.auth.dependencies import get_current_user
from tests.services.conversations.test_search import chat, db, user  # noqa: F401


async def test_search_route_and_rollout_flag(db):  # noqa: F811
    owner = await user(db)
    await chat(db, owner, body="秘密搜索")
    app = create_app()

    async def session():
        yield db

    app.dependency_overrides[get_session] = session
    app.dependency_overrides[get_current_user] = lambda: owner
    settings = get_settings().model_copy(update={"conversation_search_enabled": True})
    app.dependency_overrides[get_settings] = lambda: settings
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/conversations/search", params={"q": "搜索"})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert len(response.json()["data"]["items"]) == 1
        assert response.json()["data"]["items"][0]["target"]["field"] == "body"
        invalid = await client.get("/api/v1/conversations/search", params={"q": "x" * 201})
        assert invalid.status_code == 422
        assert invalid.headers["cache-control"] == "no-store"
        settings.conversation_search_enabled = False
        disabled = await client.get("/api/v1/conversations/search")
        assert disabled.status_code == 404
