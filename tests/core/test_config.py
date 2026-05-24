from collections.abc import Mapping
from pathlib import Path

import pytest
from dotenv import dotenv_values
from pydantic import ValidationError
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
    "SUMMARY_PROVIDER_NAME",
    "SUMMARY_MODEL",
    "LOG_LEVEL",
]


def env_value(values: Mapping[str, str | None], key: str) -> str:
    value = values[key]
    assert value is not None
    return value


def test_settings_require_configuration_when_env_file_is_disabled(
    monkeypatch: MonkeyPatch,
) -> None:
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)

    with pytest.raises(ValidationError) as exc_info:
        Settings(_env_file=None)  # type: ignore[call-arg]

    missing_fields = {error["loc"][0] for error in exc_info.value.errors()}
    assert "database_url" in missing_fields
    assert "jwt_secret" in missing_fields
    assert "deepseek_api_key" in missing_fields


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
    monkeypatch.setenv("AUTO_TITLE_ENABLED", "false")
    monkeypatch.setenv("SUMMARY_PROVIDER_NAME", "deepseek")
    monkeypatch.setenv("SUMMARY_MODEL", "deepseek-summary")
    monkeypatch.setenv("AUTO_TITLE_MAX_CHARS", "24")
    monkeypatch.setenv("AUTO_TITLE_MAX_OUTPUT_TOKENS", "36")
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
    assert settings.auto_title_enabled is False
    assert settings.summary_provider_name == "deepseek"
    assert settings.summary_model == "deepseek-summary"
    assert settings.auto_title_max_chars == 24
    assert settings.auto_title_max_output_tokens == 36
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
    assert settings.auto_title_enabled is True
    assert settings.summary_provider_name == env_value(example_values, "SUMMARY_PROVIDER_NAME")
    assert settings.summary_model == env_value(example_values, "SUMMARY_MODEL")
    assert settings.auto_title_max_chars == int(env_value(example_values, "AUTO_TITLE_MAX_CHARS"))
    assert settings.auto_title_max_output_tokens == int(
        env_value(example_values, "AUTO_TITLE_MAX_OUTPUT_TOKENS")
    )
    assert settings.log_level == env_value(example_values, "LOG_LEVEL")
    assert settings.cors_allowed_origins_list == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_ci_workflow_provides_required_settings_env() -> None:
    workflow = Path(".github/workflows/ci.yml").read_text()

    for key in ENV_KEYS:
        assert f"{key}:" in workflow


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
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
    )

    assert settings.log_level == "INFO"


def test_reasoning_effort_defaults_to_high_and_normalizes_case(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPSEEK_REASONING_EFFORT", raising=False)
    settings = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=True,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
    )
    assert settings.deepseek_reasoning_effort == "high"

    # model_copy bypasses validators; assert case-normalization via construction instead:
    built = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=True,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
        deepseek_reasoning_effort="HIGH",
    )
    assert built.deepseek_reasoning_effort == "high"


def test_reasoning_effort_rejects_invalid_value() -> None:
    with pytest.raises(ValidationError):
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            jwt_secret="secret",
            jwt_access_token_ttl_seconds=900,
            refresh_token_ttl_seconds=2_592_000,
            deepseek_api_key="key",
            deepseek_base_url="https://deepseek.example",
            deepseek_model="deepseek-test",
            deepseek_thinking_enabled=True,
            default_system_prompt="Be helpful.",
            run_lease_seconds=60,
            worker_poll_interval_seconds=2,
            worker_heartbeat_interval_seconds=10,
            summary_provider_name="deepseek",
            summary_model="deepseek-summary",
            log_level="info",
            deepseek_reasoning_effort="ludicrous",
        )


def test_cors_allowed_origins_parses_comma_separated_list() -> None:
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
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
        cors_allowed_origins="http://localhost:5173, http://127.0.0.1:5173 ,",
    )

    assert settings.cors_allowed_origins_list == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_allowed_origins_defaults_to_empty_list() -> None:
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
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
    )

    assert settings.cors_allowed_origins_list == []
