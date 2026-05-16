from os import environ


def pytest_configure() -> None:
    environ.setdefault("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost:5432/db")
    environ.setdefault("JWT_SECRET", "test-jwt-secret-with-at-least-32-bytes")
    environ.setdefault("JWT_ACCESS_TOKEN_TTL_SECONDS", "900")
    environ.setdefault("REFRESH_TOKEN_TTL_SECONDS", "2592000")
    environ.setdefault("DEEPSEEK_API_KEY", "key")
    environ.setdefault("DEEPSEEK_BASE_URL", "https://deepseek.example")
    environ.setdefault("DEEPSEEK_MODEL", "deepseek-test")
    environ.setdefault("DEEPSEEK_THINKING_ENABLED", "false")
    environ.setdefault("DEFAULT_SYSTEM_PROMPT", "Be helpful.")
    environ.setdefault("RUN_LEASE_SECONDS", "60")
    environ.setdefault("WORKER_POLL_INTERVAL_SECONDS", "2")
    environ.setdefault("WORKER_HEARTBEAT_INTERVAL_SECONDS", "10")
    environ.setdefault("LOG_LEVEL", "INFO")
