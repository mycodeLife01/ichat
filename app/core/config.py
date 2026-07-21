from functools import lru_cache
from typing import Self

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    jwt_secret: str
    jwt_access_token_ttl_seconds: int
    refresh_token_ttl_seconds: int
    deepseek_api_key: str
    deepseek_base_url: str
    deepseek_model: str
    deepseek_thinking_enabled: bool
    deepseek_reasoning_effort: str = "high"
    # Optional override for the assistant's base system prompt. Empty (default)
    # means use the bundled production prompt in app/agent/.
    default_system_prompt: str = ""
    context_budget_tokens: int = 64_000
    run_lease_seconds: int
    worker_poll_interval_seconds: float
    worker_heartbeat_interval_seconds: float
    worker_max_inflight_runs: int = 8
    run_stream_maxlen: int = 2048
    run_stream_ttl_seconds: int = 600
    run_stream_orphan_ttl_seconds: int = 86_400
    draft_checkpoint_interval_seconds: float = 3.0
    draft_checkpoint_max_pending_chars: int = 4096
    db_pool_size: int = 20
    db_max_overflow: int = 20
    db_pool_timeout_seconds: float = 30.0
    auto_title_enabled: bool = True
    summary_provider_name: str
    summary_model: str
    auto_title_max_chars: int = 32
    auto_title_max_output_tokens: int = 40
    log_level: str
    cors_allowed_origins: str = ""
    web_search_enabled: bool = False
    web_search_provider: str = "tavily"
    tavily_api_key: str = ""
    tavily_base_url: str = "https://api.tavily.com"
    web_search_max_tool_calls: int = 2
    web_search_search_timeout_seconds: float = 12.0
    web_search_extract_timeout_seconds: float = 8.0
    web_search_total_timeout_seconds: float = 25.0
    web_search_default_max_results: int = 5
    web_search_max_extract_results: int = 3
    web_search_max_evidence_chars: int = 10_000
    web_search_max_source_chars: int = 1_200

    # --- Redis / Celery (email + rate limiting) ---
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/0"
    # Result backend deliberately disabled: task outcomes are written to
    # email_outbox, never read back through Celery.
    celery_result_backend: str = ""

    # --- Email / verification ---
    frontend_app_url: str = "http://localhost:5173"
    # postmark | resend | console | fake. console/fake skip credential checks.
    email_provider: str = "console"
    email_from: str = "iChat <no-reply@mail.feslia.com>"
    email_reply_to: str = ""
    postmark_server_token: str = ""
    postmark_message_stream: str = "outbound"
    postmark_base_url: str = "https://api.postmarkapp.com"
    postmark_timeout_seconds: float = 10.0
    resend_api_key: str = ""
    resend_base_url: str = "https://api.resend.com"
    resend_timeout_seconds: float = 10.0

    auth_email_verification_token_ttl_seconds: int = 86_400
    auth_email_verification_cooldown_seconds: int = 60
    auth_password_reset_token_ttl_seconds: int = 1_800
    auth_account_deletion_token_ttl_seconds: int = 1_800

    # IP-dimension sliding-window rate limits (limit per window seconds).
    auth_rate_register_ip_limit: int = 5
    auth_rate_register_ip_window_seconds: int = 3_600
    auth_rate_resend_ip_limit: int = 10
    auth_rate_resend_ip_window_seconds: int = 3_600
    auth_rate_verify_ip_limit: int = 30
    auth_rate_verify_ip_window_seconds: int = 60
    auth_rate_password_reset_request_ip_limit: int = 5
    auth_rate_password_reset_request_ip_window_seconds: int = 3_600
    # change-password anti-brute-force: failed attempts per user + IP window.
    auth_rate_password_change_user_limit: int = 5
    auth_rate_password_change_user_window_seconds: int = 900
    auth_rate_password_change_ip_limit: int = 10
    auth_rate_password_change_ip_window_seconds: int = 3_600
    auth_rate_deletion_request_ip_limit: int = 5
    auth_rate_deletion_request_ip_window_seconds: int = 3_600

    email_outbox_max_attempts: int = 5
    email_outbox_lease_seconds: int = 120
    email_outbox_sweep_interval_seconds: int = 60

    # --- Avatar uploads / Cloudflare R2 ---
    avatar_storage_enabled: bool = False
    avatar_r2_endpoint_url: str = ""
    avatar_r2_region: str = "auto"
    avatar_upload_bucket: str = ""
    avatar_public_bucket: str = ""
    avatar_api_access_key_id: str = ""
    avatar_api_secret_access_key: str = ""
    avatar_worker_access_key_id: str = ""
    avatar_worker_secret_access_key: str = ""
    avatar_public_base_url: str = ""
    cloudflare_zone_id: str = ""
    cloudflare_purge_token: str = ""
    avatar_presign_ttl_seconds: int = 600
    avatar_session_ttl_seconds: int = 1_800
    avatar_upload_max_bytes: int = 2 * 1024 * 1024
    avatar_rate_user_limit: int = 10
    avatar_rate_ip_limit: int = 30
    avatar_rate_window_seconds: int = 3_600
    avatar_processing_lease_seconds: int = 300
    avatar_processing_max_attempts: int = 3
    avatar_maintenance_interval_seconds: int = 3_600
    avatar_maintenance_batch_size: int = 100
    avatar_history_retention_seconds: int = 7 * 86_400
    avatar_cleanup_safety_seconds: int = 300

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("log_level")
    @classmethod
    def normalize_log_level(cls, value: str) -> str:
        return value.upper()

    @field_validator("deepseek_reasoning_effort")
    @classmethod
    def normalize_reasoning_effort(cls, value: str) -> str:
        normalized = value.strip().lower()
        allowed = {"low", "medium", "high", "xhigh", "max"}
        if normalized not in allowed:
            raise ValueError(
                f"deepseek_reasoning_effort must be one of {sorted(allowed)}, got {value!r}"
            )
        return normalized

    @field_validator("email_provider")
    @classmethod
    def normalize_email_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        allowed = {"postmark", "resend", "console", "fake"}
        if normalized not in allowed:
            raise ValueError(f"email_provider must be one of {sorted(allowed)}, got {value!r}")
        return normalized

    @model_validator(mode="after")
    def validate_external_services(self) -> Self:
        # Only enforce provider credentials when the integration is active, so
        # fake/disabled integrations can boot in dev and CI without secrets.
        if self.email_provider == "postmark":
            missing = [
                name
                for name, value in (
                    ("postmark_server_token", self.postmark_server_token),
                    ("email_from", self.email_from),
                )
                if not value.strip()
            ]
            if missing:
                raise ValueError(
                    f"email_provider=postmark requires non-empty: {', '.join(missing)}"
                )
        if self.email_provider == "resend":
            missing = [
                name
                for name, value in (
                    ("resend_api_key", self.resend_api_key),
                    ("email_from", self.email_from),
                )
                if not value.strip()
            ]
            if missing:
                raise ValueError(
                    f"email_provider=resend requires non-empty: {', '.join(missing)}"
                )
        if self.avatar_storage_enabled:
            required = (
                ("avatar_r2_endpoint_url", self.avatar_r2_endpoint_url),
                ("avatar_upload_bucket", self.avatar_upload_bucket),
                ("avatar_public_bucket", self.avatar_public_bucket),
                ("avatar_api_access_key_id", self.avatar_api_access_key_id),
                ("avatar_api_secret_access_key", self.avatar_api_secret_access_key),
                ("avatar_worker_access_key_id", self.avatar_worker_access_key_id),
                ("avatar_worker_secret_access_key", self.avatar_worker_secret_access_key),
                ("avatar_public_base_url", self.avatar_public_base_url),
                ("cloudflare_zone_id", self.cloudflare_zone_id),
                ("cloudflare_purge_token", self.cloudflare_purge_token),
            )
            missing = [name for name, value in required if not value.strip()]
            if missing:
                raise ValueError(
                    f"avatar_storage_enabled=true requires non-empty: {', '.join(missing)}"
                )
        return self

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]

    @property
    def web_search_available(self) -> bool:
        return self.web_search_enabled and bool(self.tavily_api_key.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
