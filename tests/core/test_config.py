from collections.abc import Mapping

from dotenv import dotenv_values
from pytest import MonkeyPatch

from app.core.config import Settings, get_settings

ENV_KEYS = [
    "DATABASE_URL",
    "JWT_SECRET",
    "JWT_ACCESS_TOKEN_TTL_SECONDS",
    "REFRESH_TOKEN_TTL_SECONDS",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_THINKING_ENABLED",
    "DEFAULT_SYSTEM_PROMPT",
    "RUN_LEASE_SECONDS",
    "WORKER_POLL_INTERVAL_SECONDS",
    "WORKER_HEARTBEAT_INTERVAL_SECONDS",
    "LOG_LEVEL",
]


def env_value(values: Mapping[str, str | None], key: str) -> str:
    value = values[key]
    assert value is not None
    return value


def test_settings_have_local_development_defaults(monkeypatch: MonkeyPatch) -> None:
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    assert settings.database_url == "postgresql+asyncpg://ichat:ichat_password@postgres:5432/ichat"
    assert settings.jwt_secret == "change-me-local-dev-only"
    assert settings.deepseek_model == "deepseek-chat"
    assert settings.log_level == "INFO"


def test_settings_parse_environment_values(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://user:pass@localhost:5432/db")
    monkeypatch.setenv("JWT_SECRET", "secret")
    monkeypatch.setenv("JWT_ACCESS_TOKEN_TTL_SECONDS", "123")
    monkeypatch.setenv("REFRESH_TOKEN_TTL_SECONDS", "456")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://deepseek.example")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-test")
    monkeypatch.setenv("DEEPSEEK_THINKING_ENABLED", "true")
    monkeypatch.setenv("DEFAULT_SYSTEM_PROMPT", "Be helpful.")
    monkeypatch.setenv("RUN_LEASE_SECONDS", "12")
    monkeypatch.setenv("WORKER_POLL_INTERVAL_SECONDS", "3")
    monkeypatch.setenv("WORKER_HEARTBEAT_INTERVAL_SECONDS", "4")
    monkeypatch.setenv("LOG_LEVEL", "debug")

    get_settings.cache_clear()
    settings = get_settings()

    assert settings.database_url == "postgresql+asyncpg://user:pass@localhost:5432/db"
    assert settings.jwt_secret == "secret"
    assert settings.jwt_access_token_ttl_seconds == 123
    assert settings.refresh_token_ttl_seconds == 456
    assert settings.deepseek_api_key == "key"
    assert settings.deepseek_base_url == "https://deepseek.example"
    assert settings.deepseek_model == "deepseek-test"
    assert settings.deepseek_thinking_enabled is True
    assert settings.default_system_prompt == "Be helpful."
    assert settings.run_lease_seconds == 12
    assert settings.worker_poll_interval_seconds == 3
    assert settings.worker_heartbeat_interval_seconds == 4
    assert settings.log_level == "DEBUG"


def test_env_example_values_match_settings_shape(monkeypatch: MonkeyPatch) -> None:
    example_values = dotenv_values(".env.example")
    for key, value in example_values.items():
        if value is not None:
            monkeypatch.setenv(key, value)

    get_settings.cache_clear()
    settings = get_settings()

    assert settings.database_url == env_value(example_values, "DATABASE_URL")
    assert settings.jwt_access_token_ttl_seconds == int(
        env_value(example_values, "JWT_ACCESS_TOKEN_TTL_SECONDS")
    )
    assert settings.refresh_token_ttl_seconds == int(
        env_value(example_values, "REFRESH_TOKEN_TTL_SECONDS")
    )
    assert settings.deepseek_thinking_enabled is False
    assert settings.log_level == env_value(example_values, "LOG_LEVEL")


def test_settings_can_be_constructed_directly() -> None:
    settings = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=False,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        log_level="info",
    )

    assert settings.log_level == "INFO"
