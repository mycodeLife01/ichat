from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.auth import router as auth_router
from app.api.v1.capabilities import router as capabilities_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.runs import router as runs_router
from app.api.v1.share import router as share_router
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging, logger
from app.db.session import check_database_ready
from app.services.run_events.subscription import RunEventSubscriptionManager

DatabaseReadyCheck = Callable[[], Awaitable[bool]]


def create_app(
    database_ready_check: DatabaseReadyCheck | None = None,
) -> FastAPI:
    app_settings = get_settings()
    configure_logging(app_settings.log_level)
    readiness_check = database_ready_check or check_database_ready

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        manager = RunEventSubscriptionManager(app_settings.database_url)
        try:
            await manager.start()
            app.state.run_event_subscriptions = manager
        except Exception:
            logger.exception(
                "RunEventSubscriptionManager failed to start; SSE will use polling fallback"
            )
            app.state.run_event_subscriptions = None
        try:
            yield
        finally:
            existing = getattr(app.state, "run_event_subscriptions", None)
            if existing is not None:
                await existing.stop()

    app = FastAPI(title="iChat API", lifespan=lifespan)
    app.include_router(capabilities_router)
    app.include_router(auth_router)
    app.include_router(conversations_router)
    app.include_router(runs_router)
    app.include_router(share_router)

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=exc.headers,
        )

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

    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_allowed_origins_list,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept"],
    )

    return app


app = create_app()
