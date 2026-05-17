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
    default_system_prompt: str
    run_lease_seconds: int
    worker_poll_interval_seconds: float
    worker_heartbeat_interval_seconds: float
    log_level: str

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("log_level")
    @classmethod
    def normalize_log_level(cls, value: str) -> str:
        return value.upper()


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
