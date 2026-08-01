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
    image_model_input: bool


class ChatModelResponse(BaseModel):
    """One user-selectable chat model. ``id`` is the provider model identifier
    the client echoes back as the run option ``model``; ``label`` is the
    display name (vendor prefix stripped); ``thinking_levels`` lists the
    selectable effort tiers, weakest to strongest."""

    id: str
    provider: str
    label: str
    thinking_levels: list[str]
    default: bool


class CapabilitiesResponse(BaseModel):
    web_search: WebSearchCapabilityResponse
    files: FileUploadCapabilityResponse
    models: list[ChatModelResponse]
