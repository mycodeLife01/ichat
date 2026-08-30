from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.schemas.capabilities import (
    CapabilitiesResponse,
    ChatModelResponse,
    FileUploadCapabilityResponse,
    WebSearchCapabilityResponse,
)
from app.schemas.responses import SuccessResponse
from app.services.files.formats import (
    IMAGE_MAX_BYTES,
    OOXML_MAX_BYTES,
    PDF_MAX_BYTES,
    TEXT_MAX_BYTES,
    supported_extensions,
)
from app.services.model_catalog import available_chat_models

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])


@router.get("", response_model=SuccessResponse[CapabilitiesResponse])
async def get_capabilities_route(
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CapabilitiesResponse]:
    models = await available_chat_models(session, settings=settings)
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
                    id=entry.key,
                    provider=entry.provider_name,
                    label=entry.label,
                    thinking_levels=list(entry.thinking_levels),
                    reasoning_outputs=list(entry.reasoning_outputs),
                    supports_reasoning_summary="summary" in entry.reasoning_outputs,
                    supports_image_input=entry.supports_image_input,
                    default=index == 0,
                )
                for index, entry in enumerate(models)
            ],
        )
    )
