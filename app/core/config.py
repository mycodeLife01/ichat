from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://ichat:ichat_password@postgres:5432/ichat"
    jwt_secret: str = "change-me-local-dev-only"
    jwt_access_token_ttl_seconds: int = 900
    refresh_token_ttl_seconds: int = 2_592_000
    deepseek_api_key: str = "replace-in-real-deployments"
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    deepseek_thinking_enabled: bool = False
    default_system_prompt: str = "You are a helpful assistant."
    run_lease_seconds: int = 60
    worker_poll_interval_seconds: int = 2
    worker_heartbeat_interval_seconds: int = 10
    log_level: str = "INFO"

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
    return Settings()
