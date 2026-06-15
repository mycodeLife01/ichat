from pydantic import BaseModel


class WebSearchCapabilityResponse(BaseModel):
    enabled: bool


class CapabilitiesResponse(BaseModel):
    web_search: WebSearchCapabilityResponse
