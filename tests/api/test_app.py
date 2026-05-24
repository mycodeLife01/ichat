from uuid import UUID

from fastapi import status
from fastapi.testclient import TestClient
from pydantic import BaseModel
from pytest import MonkeyPatch

from app.core.config import get_settings
from app.core.errors import AppError
from app.main import app, create_app
from app.schemas.responses import SuccessResponse


async def ready() -> bool:
    return True


class StatusResponse(BaseModel):
    status: str


def test_healthz_returns_ok() -> None:
    client = TestClient(create_app(database_ready_check=ready))

    response = client.get("/healthz")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"status": "ok"}


def test_readyz_returns_ok_when_database_is_ready() -> None:
    client = TestClient(create_app(database_ready_check=ready))

    response = client.get("/readyz")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"status": "ok"}


def test_create_app_does_not_store_settings_on_app_state() -> None:
    app = create_app(database_ready_check=ready)

    assert not hasattr(app.state, "settings")


def test_api_v1_success_response_omits_empty_meta() -> None:
    app = create_app(database_ready_check=ready)

    @app.get(
        "/api/v1/test-envelope",
        response_model=SuccessResponse[StatusResponse],
        response_model_exclude_none=True,
    )
    async def test_envelope() -> SuccessResponse[StatusResponse]:
        return SuccessResponse(data=StatusResponse(status="ok"))

    client = TestClient(app)

    response = client.get("/api/v1/test-envelope")

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"data": {"status": "ok"}}


def test_request_id_header_is_generated_when_missing() -> None:
    client = TestClient(create_app(database_ready_check=ready))

    response = client.get("/healthz")

    UUID(response.headers["X-Request-ID"])


def test_request_id_header_is_preserved_when_provided() -> None:
    client = TestClient(create_app(database_ready_check=ready))

    response = client.get("/healthz", headers={"X-Request-ID": "req-existing"})

    assert response.headers["X-Request-ID"] == "req-existing"


def test_app_error_handler_returns_detail_only() -> None:
    app = create_app(database_ready_check=ready)

    @app.get("/raises-app-error")
    async def raises_app_error() -> None:
        raise AppError(status.HTTP_409_CONFLICT, "Active run already exists")

    client = TestClient(app)

    response = client.get("/raises-app-error")

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json() == {"detail": "Active run already exists"}


def test_unhandled_error_handler_returns_generic_detail() -> None:
    app = create_app(database_ready_check=ready)

    @app.get("/raises-unhandled-error")
    async def raises_unhandled_error() -> None:
        raise RuntimeError("boom")

    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/raises-unhandled-error")

    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    assert response.json() == {"detail": "Internal server error"}


def test_root_path_does_not_serve_frontend() -> None:
    client = TestClient(app)

    response = client.get("/")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "text/html" not in response.headers.get("content-type", "")


def test_cors_allows_configured_origin(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(database_ready_check=ready))

        response = client.get("/healthz", headers={"Origin": "http://localhost:5173"})

        assert response.status_code == status.HTTP_200_OK
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    finally:
        get_settings.cache_clear()


def test_cors_preflight_allows_methods(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(database_ready_check=ready))

        response = client.options(
            "/api/v1/conversations",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
        allow_methods = response.headers["access-control-allow-methods"]
        assert "POST" in allow_methods
        assert "PATCH" in allow_methods
        assert "DELETE" in allow_methods
    finally:
        get_settings.cache_clear()


def test_cors_omits_headers_for_unknown_origin(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(database_ready_check=ready))

        response = client.get("/healthz", headers={"Origin": "https://evil.example"})

        assert response.status_code == status.HTTP_200_OK
        assert "access-control-allow-origin" not in response.headers
    finally:
        get_settings.cache_clear()
