from collections.abc import Awaitable, Callable
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.auth import router as auth_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.runs import router as runs_router
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging, logger
from app.db.session import check_database_ready

DatabaseReadyCheck = Callable[[], Awaitable[bool]]


def create_app(
    database_ready_check: DatabaseReadyCheck | None = None,
) -> FastAPI:
    app_settings = get_settings()
    configure_logging(app_settings.log_level)
    readiness_check = database_ready_check or check_database_ready

    app = FastAPI(title="iChat API")
    app.include_router(auth_router)
    app.include_router(conversations_router)
    app.include_router(runs_router)

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled application error")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Internal server error"},
        )

    @app.middleware("http")
    async def request_id_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        with logger.contextualize(request_id=request_id):
            response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz() -> dict[str, str]:
        if not await readiness_check():
            raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, "Database is not ready")
        return {"status": "ok"}

    return app


app = create_app()

frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
