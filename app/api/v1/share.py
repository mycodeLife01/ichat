from typing import Annotated

from fastapi import APIRouter, Depends, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.schemas.files import FileReadUrlResponse, ShareAttachmentReadRequest
from app.schemas.responses import SuccessResponse
from app.schemas.shares import PublicShareResponse
from app.services.auth import rate_limit
from app.services.files.dependencies import (
    get_file_download_storage,
    get_file_preview_api_storage,
)
from app.services.files.protocols import FileStorage
from app.services.shares.service import (
    get_public_share,
    get_public_share_attachment_read_url,
    guard_public_read_rate_limit,
)

router = APIRouter(prefix="/api/v1/share", tags=["share"])


@router.get(
    "/{token}",
    response_model=SuccessResponse[PublicShareResponse],
)
async def get_public_share_route(
    token: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[PublicShareResponse]:
    # Public, unauthenticated by design: anyone with the token reads the frozen
    # snapshot. Scope is strictly the snapshot — no ownership, no live data.
    share = await get_public_share(session, token=token)
    return SuccessResponse(data=share)


@router.post(
    "/{token}/attachments/{ref}/read-url",
    response_model=SuccessResponse[FileReadUrlResponse],
)
async def create_public_share_attachment_read_url_route(
    token: str,
    ref: str,
    body: ShareAttachmentReadRequest,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
    storage: Annotated[FileStorage, Depends(get_file_download_storage)],
    preview_storage: Annotated[FileStorage, Depends(get_file_preview_api_storage)],
) -> SuccessResponse[FileReadUrlResponse]:
    # Also public by design: the share token is the capability. Throttle before
    # touching the database so probing unknown tokens still consumes budget.
    await guard_public_read_rate_limit(
        redis,
        token=token,
        role=body.role,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
    return SuccessResponse(
        data=await get_public_share_attachment_read_url(
            session,
            storage,
            token=token,
            ref=ref,
            role=body.role,
            settings=settings,
            preview_storage=preview_storage,
        )
    )
