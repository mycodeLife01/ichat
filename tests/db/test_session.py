from types import TracebackType
from typing import Any, Self

from pytest import MonkeyPatch
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import check_database_ready, create_session_factory, get_session_factory


def test_create_session_factory_returns_async_session() -> None:
    session_factory = create_session_factory("postgresql+asyncpg://user:pass@localhost:5432/db")

    assert isinstance(session_factory(), AsyncSession)


def test_get_session_factory_is_cached(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost:5432/db")
    monkeypatch.setenv("JWT_SECRET", "secret")
    monkeypatch.setenv("JWT_ACCESS_TOKEN_TTL_SECONDS", "123")
    monkeypatch.setenv("REFRESH_TOKEN_TTL_SECONDS", "456")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://deepseek.example")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-test")
    monkeypatch.setenv("DEEPSEEK_THINKING_ENABLED", "false")
    monkeypatch.setenv("DEFAULT_SYSTEM_PROMPT", "Be helpful.")
    monkeypatch.setenv("RUN_LEASE_SECONDS", "12")
    monkeypatch.setenv("WORKER_POLL_INTERVAL_SECONDS", "3")
    monkeypatch.setenv("WORKER_HEARTBEAT_INTERVAL_SECONDS", "4")
    monkeypatch.setenv("SUMMARY_MODEL", "deepseek-test")
    monkeypatch.setenv("LOG_LEVEL", "INFO")

    get_settings.cache_clear()
    get_session_factory.cache_clear()

    assert get_session_factory() is get_session_factory()


class ReadySession:
    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    async def execute(self, statement: Any) -> None:
        return None


class FailingSession:
    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    async def execute(self, statement: Any) -> None:
        raise RuntimeError("database down")


def ready_session_factory() -> ReadySession:
    return ReadySession()


def failing_session_factory() -> FailingSession:
    return FailingSession()


async def test_check_database_ready_returns_true_when_select_succeeds() -> None:
    assert await check_database_ready(session_factory=ready_session_factory) is True


async def test_check_database_ready_returns_false_when_select_fails() -> None:
    assert await check_database_ready(session_factory=failing_session_factory) is False
