from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConversationCreateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: Any) -> Any:
        if isinstance(value, str):
            normalized = value.strip()
            return normalized or None
        return value


class ConversationRenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value


ReasoningEffort = Literal["low", "medium", "high", "xhigh", "max"]


class RunOptionsRequest(BaseModel):
    """Per-request overrides for provider thinking behavior.

    A ``None`` field means "use the server default from env config".
    """

    thinking_enabled: bool | None = None
    reasoning_effort: ReasoningEffort | None = None
    web_search_enabled: bool | None = None


class MessageCreateRequest(RunOptionsRequest):
    content: str = Field(min_length=1, max_length=20000)

    @field_validator("content")
    @classmethod
    def reject_blank_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content is required")
        return value


class ConversationResponse(BaseModel):
    id: int
    title: str | None
    activated_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageResponse(BaseModel):
    id: int
    conversation_id: int
    run_id: int | None
    role: Literal["user", "assistant"]
    content: str
    reasoning: str | None = None
    metadata: dict[str, Any] | None = None
    position: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RunResponse(BaseModel):
    id: int
    conversation_id: int
    user_message_id: int
    status: Literal[
        "queued",
        "started",
        "streaming",
        "succeeded",
        "failed",
        "cancelling",
        "cancelled",
    ]
    provider_name: str
    provider_model: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ConversationDetailResponse(ConversationResponse):
    messages: list[MessageResponse]


class SendMessageResponse(BaseModel):
    message: MessageResponse
    run: RunResponse
