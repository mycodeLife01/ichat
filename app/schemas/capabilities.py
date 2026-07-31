from pydantic import BaseModel


class WebSearchCapabilityResponse(BaseModel):
    enabled: bool


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
    models: list[ChatModelResponse]
