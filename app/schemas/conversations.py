import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.files import MessageAttachmentResponse


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
    ``model`` picks the chat model for this run; it must be one of the ids the
    capabilities endpoint lists, and ``None`` selects the catalog default.
    """

    thinking_enabled: bool | None = None
    reasoning_effort: ReasoningEffort | None = None
    web_search_enabled: bool | None = None
    model: str | None = Field(default=None, min_length=1, max_length=128)


class MessageCreateRequest(RunOptionsRequest):
    content: str = Field(default="", max_length=20000)
    attachment_ids: list[uuid.UUID] | None = Field(default=None, max_length=5)

    @field_validator("attachment_ids")
    @classmethod
    def reject_duplicate_attachments(
        cls, value: list[uuid.UUID] | None
    ) -> list[uuid.UUID] | None:
        if value is not None and len(value) != len(set(value)):
            raise ValueError("Attachment IDs must be unique")
        return value

    @model_validator(mode="after")
    def require_text_or_attachment(self) -> "MessageCreateRequest":
        if not self.content.strip() and not self.attachment_ids:
            raise ValueError("Enter a message or attach a readable file")
        return self


class ConversationCreateWithMessageRequest(MessageCreateRequest):
    title: str | None = Field(default=None, max_length=255)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: Any) -> Any:
        if isinstance(value, str):
            normalized = value.strip()
            return normalized or None
        return value


class ConversationResponse(BaseModel):
    id: uuid.UUID = Field(validation_alias="public_id")
    title: str | None
    activated_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    deletion_due_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class MessageResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    run_id: uuid.UUID | None
    role: Literal["user", "assistant"]
    content: str
    reasoning: str | None = None
    metadata: dict[str, Any] | None = None
    position: int
    created_at: datetime
    attachments: list[MessageAttachmentResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class RunResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    user_message_id: uuid.UUID
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


class ImageContextResponse(BaseModel):
    state: Literal["none", "vision_required", "legacy_upgrade_required"]
    legacy_message_id: uuid.UUID | None = None
    recommended_model: str | None = None


def _default_image_context() -> ImageContextResponse:
    return ImageContextResponse(state="none")


class ConversationDetailResponse(ConversationResponse):
    messages: list[MessageResponse]
    image_context: ImageContextResponse = Field(default_factory=_default_image_context)


class SendMessageResponse(BaseModel):
    message: MessageResponse
    run: RunResponse
    image_context: ImageContextResponse = Field(default_factory=_default_image_context)


class ConversationCreateWithMessageResponse(SendMessageResponse):
    conversation: ConversationResponse
