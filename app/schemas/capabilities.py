from pydantic import BaseModel


class WebSearchCapabilityResponse(BaseModel):
    enabled: bool


class FileUploadCapabilityResponse(BaseModel):
    enabled: bool
    allowed_extensions: list[str]
    category_max_bytes: dict[str, int]
    max_attachments_per_message: int
    max_message_bytes: int
    quota_bytes: int
    target_turn_tokens: int
    context_budget_tokens: int


class ChatModelResponse(BaseModel):
    """One user-selectable chat model. ``id`` is the stable logical model key
    the client echoes back as the run option ``model``; ``provider`` identifies
    the currently selected adapter; ``thinking_levels`` lists the selectable
    effort tiers, weakest to strongest."""

    id: str
    provider: str
    label: str
    thinking_levels: list[str]
    reasoning_outputs: list[str]
    supports_reasoning_summary: bool
    supports_image_input: bool
    default: bool


class CapabilitiesResponse(BaseModel):
    web_search: WebSearchCapabilityResponse
    files: FileUploadCapabilityResponse
    models: list[ChatModelResponse]
