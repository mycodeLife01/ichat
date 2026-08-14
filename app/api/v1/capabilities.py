from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.schemas.capabilities import (
    CapabilitiesResponse,
    ChatModelResponse,
    FileUploadCapabilityResponse,
    WebSearchCapabilityResponse,
)
from app.schemas.responses import SuccessResponse
from app.services.agents.catalog import available_chat_models
from app.services.files.formats import (
    IMAGE_MAX_BYTES,
    OOXML_MAX_BYTES,
    PDF_MAX_BYTES,
    TEXT_MAX_BYTES,
    supported_extensions,
)

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])


@router.get("", response_model=SuccessResponse[CapabilitiesResponse])
async def get_capabilities_route(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[CapabilitiesResponse]:
    models = available_chat_models(settings)
    return SuccessResponse(
        data=CapabilitiesResponse(
            web_search=WebSearchCapabilityResponse(enabled=settings.web_search_available),
            files=FileUploadCapabilityResponse(
                enabled=settings.file_upload_enabled,
                allowed_extensions=list(supported_extensions()),
                category_max_bytes={
                    "image": IMAGE_MAX_BYTES,
                    "pdf": PDF_MAX_BYTES,
                    "office": OOXML_MAX_BYTES,
                    "text": TEXT_MAX_BYTES,
                },
                max_attachments_per_message=settings.files_max_attachments_per_message,
                max_message_bytes=settings.files_max_message_bytes,
                quota_bytes=settings.files_quota_bytes,
                target_turn_tokens=settings.attachment_target_turn_tokens,
                context_budget_tokens=settings.context_budget_tokens,
            ),
            models=[
                ChatModelResponse(
                    id=entry.model,
                    provider=entry.provider_name,
                    label=entry.label,
                    thinking_levels=list(entry.thinking_levels),
                    supports_image_input=entry.supports_image_input,
                    default=index == 0,
                )
                for index, entry in enumerate(models)
            ],
        )
    )
