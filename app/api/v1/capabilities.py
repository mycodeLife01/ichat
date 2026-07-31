from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.schemas.capabilities import (
    CapabilitiesResponse,
    ChatModelResponse,
    WebSearchCapabilityResponse,
)
from app.schemas.responses import SuccessResponse
from app.services.agents.catalog import available_chat_models

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])


@router.get("", response_model=SuccessResponse[CapabilitiesResponse])
async def get_capabilities_route(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[CapabilitiesResponse]:
    models = available_chat_models(settings)
    return SuccessResponse(
        data=CapabilitiesResponse(
            web_search=WebSearchCapabilityResponse(enabled=settings.web_search_available),
            models=[
                ChatModelResponse(
                    id=entry.model,
                    provider=entry.provider_name,
                    label=entry.label,
                    thinking_levels=list(entry.thinking_levels),
                    default=index == 0,
                )
                for index, entry in enumerate(models)
            ],
        )
    )
