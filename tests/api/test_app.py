from uuid import UUID

from fastapi import status
from fastapi.testclient import TestClient

from app.core.errors import AppError
from app.main import create_app


async def ready() -> bool:
    return True


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
