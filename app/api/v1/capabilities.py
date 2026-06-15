from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.schemas.capabilities import CapabilitiesResponse, WebSearchCapabilityResponse
from app.schemas.responses import SuccessResponse

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])


@router.get("", response_model=SuccessResponse[CapabilitiesResponse])
async def get_capabilities_route(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[CapabilitiesResponse]:
    return SuccessResponse(
        data=CapabilitiesResponse(
            web_search=WebSearchCapabilityResponse(enabled=settings.web_search_available),
        )
    )
