from functools import lru_cache

from pydantic import field_validator
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
    default_system_prompt: str
    context_budget_tokens: int = 64_000
    run_lease_seconds: int
    worker_poll_interval_seconds: float
    worker_heartbeat_interval_seconds: float
    worker_max_inflight_runs: int = 8
    worker_delta_batch_window_ms: int = 50
    worker_delta_batch_max_chars: int = 256
    db_pool_size: int = 20
    db_max_overflow: int = 20
    db_pool_timeout_seconds: float = 30.0
    sse_fallback_interval_seconds: float = 5.0
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

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.cors_allowed_origins.split(",")
            if origin.strip()
        ]

    @property
    def web_search_available(self) -> bool:
        return self.web_search_enabled and bool(self.tavily_api_key.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
