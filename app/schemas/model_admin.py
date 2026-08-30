from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

ThinkingLevel = Literal["low", "medium", "high", "xhigh", "max"]
TokenProfile = Literal["default", "deepseek", "openai"]
ProviderAdapter = Literal["deepseek", "openai", "openrouter"]
ReasoningOutput = Literal["raw", "summary"]


class ModelAdminRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelAdminChatModelResponse(BaseModel):
    key: str
    label: str
    thinking_levels: list[ThinkingLevel]
    supports_image_input: bool
    image_token_reserve: int | None
    token_profile: TokenProfile
    sort_order: int
    enabled: bool


class ModelAdminUpstreamResponse(BaseModel):
    key: str
    label: str
    adapter: ProviderAdapter
    base_url: str
    api_key_hint: str
    enabled: bool


class ModelAdminRouteResponse(BaseModel):
    model_key: str
    upstream_key: str
    upstream_model: str
    reasoning_outputs: list[ReasoningOutput]
    priority: int
    enabled: bool
    selected: bool


class ModelAdminCatalogResponse(BaseModel):
    database_enabled: bool
    models: list[ModelAdminChatModelResponse]
    upstreams: list[ModelAdminUpstreamResponse]
    routes: list[ModelAdminRouteResponse]


class UpsertChatModelRequest(ModelAdminRequest):
    label: str = Field(min_length=1, max_length=128)
    thinking_levels: list[ThinkingLevel] = Field(default_factory=list, max_length=5)
    supports_image_input: bool = False
    image_token_reserve: int | None = Field(default=None, ge=1)
    token_profile: TokenProfile = "default"
    sort_order: int = Field(default=100, ge=0)
    enabled: bool | None = None

    @model_validator(mode="after")
    def validate_image_capability(self) -> Self:
        if self.supports_image_input != (self.image_token_reserve is not None):
            raise ValueError(
                "image_token_reserve is required exactly when image input is supported"
            )
        return self


class UpsertModelUpstreamRequest(ModelAdminRequest):
    label: str = Field(min_length=1, max_length=128)
    adapter: ProviderAdapter
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: SecretStr | None = None
    enabled: bool | None = None


class UpsertModelRouteRequest(ModelAdminRequest):
    model_key: str = Field(min_length=1, max_length=128)
    upstream_key: str = Field(min_length=1, max_length=128)
    upstream_model: str = Field(min_length=1, max_length=256)
    reasoning_outputs: list[ReasoningOutput] = Field(default_factory=list, max_length=2)
    priority: int = Field(default=100, ge=0)
    enabled: bool | None = None


class EnabledRequest(ModelAdminRequest):
    enabled: bool


class SetModelRouteEnabledRequest(ModelAdminRequest):
    model_key: str = Field(min_length=1, max_length=128)
    upstream_key: str = Field(min_length=1, max_length=128)
    upstream_model: str = Field(min_length=1, max_length=256)
    enabled: bool


class SetCatalogStateRequest(ModelAdminRequest):
    database_enabled: bool


class ImportEnvironmentCatalogRequest(ModelAdminRequest):
    activate: bool = False
