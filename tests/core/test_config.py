from collections.abc import Mapping
from pathlib import Path

import pytest
from dotenv import dotenv_values
from pydantic import ValidationError
from pytest import MonkeyPatch

from app.core.config import (
    Settings,
    get_settings,
    validate_api_vision_settings,
    validate_worker_vision_settings,
)

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


def test_avatar_storage_requires_all_external_credentials_when_enabled() -> None:
    values = get_settings().model_dump()
    values.update(
        avatar_storage_enabled=True,
        avatar_r2_endpoint_url="https://account.r2.cloudflarestorage.com",
        avatar_upload_bucket="uploads",
        avatar_public_bucket="avatars",
        avatar_api_access_key_id="api-key",
        avatar_api_secret_access_key="api-secret",
        avatar_worker_access_key_id="worker-key",
        avatar_worker_secret_access_key="worker-secret",
        avatar_public_base_url="https://assets.example.com",
        cloudflare_zone_id="zone",
        cloudflare_purge_token="",
    )
    with pytest.raises(ValidationError, match="cloudflare_purge_token"):
        Settings.model_validate(values)


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
        cors_allowed_origins="",
    )

    assert settings.log_level == "INFO"


def test_file_multipart_settings_reject_parts_below_provider_minimum() -> None:
    values = get_settings().model_dump()
    values["files_multipart_part_size_bytes"] = 5 * 1024 * 1024 - 1

    with pytest.raises(ValidationError, match="at least 5 MiB"):
        Settings.model_validate(values)


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
        cors_allowed_origins="",
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
        cors_allowed_origins="",
    )

    assert settings.cors_allowed_origins_list == []


def _vision_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "openai_api_key": "openai-key",
        "openai_models": "gpt-5-mini",
        "openai_vision_models": "gpt-5-mini",
        "files_r2_endpoint_url": "https://account.r2.cloudflarestorage.com",
        "files_staging_bucket": "staging",
        "files_canonical_bucket": "canonical",
        "files_preview_bucket": "preview",
        "files_preview_api_access_key_id": "preview-api-key",
        "files_preview_api_secret_access_key": "preview-api-secret",
        "files_preview_llm_access_key_id": "preview-llm-key",
        "files_preview_llm_secret_access_key": "preview-llm-secret",
    }
    values.update(overrides)
    return get_settings().model_copy(update=values)


def _validate_settings(**overrides: object) -> Settings:
    values = get_settings().model_dump()
    values.update(overrides)
    return Settings.model_validate(values)


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"openai_models": ""}, "must not be empty"),
        ({"openai_models": "gpt-5-mini,"}, "entries must not be empty"),
        (
            {"openai_models": "gpt-5-mini", "openai_vision_models": "gpt-5-mini,gpt-5-mini"},
            "entries must be unique",
        ),
        (
            {"openai_models": "gpt-5-mini", "openai_vision_models": "gpt-5"},
            "must be a subset",
        ),
        ({"openai_image_token_reserve": 0}, "must be positive"),
    ],
)
def test_invalid_vision_model_configuration_fails_during_settings_validation(
    overrides: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValidationError, match=message):
        _validate_settings(**overrides)


def test_empty_vision_allowlist_is_a_valid_kill_switch_without_preview_credentials() -> None:
    settings = _vision_settings(
        openai_vision_models="",
        files_preview_bucket="",
        files_preview_api_access_key_id="",
        files_preview_api_secret_access_key="",
        files_preview_llm_access_key_id="",
        files_preview_llm_secret_access_key="",
    )

    validate_api_vision_settings(settings)
    validate_worker_vision_settings(settings)


def test_vision_runtime_validators_require_their_separate_preview_credentials() -> None:
    with pytest.raises(ValueError, match="files_preview_api_access_key_id"):
        validate_api_vision_settings(_vision_settings(files_preview_api_access_key_id=""))

    with pytest.raises(ValueError, match="files_preview_llm_access_key_id"):
        validate_worker_vision_settings(_vision_settings(files_preview_llm_access_key_id=""))


def test_vision_runtime_rejects_preview_bucket_aliasing_an_original_bucket() -> None:
    settings = _vision_settings(files_preview_bucket="canonical")

    with pytest.raises(ValueError, match="must be distinct"):
        validate_api_vision_settings(settings)
    with pytest.raises(ValueError, match="must be distinct"):
        validate_worker_vision_settings(settings)
