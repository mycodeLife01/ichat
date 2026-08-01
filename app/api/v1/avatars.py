from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.models.user import User
from app.schemas.avatars import (
    AvatarUploadResponse,
    ConfirmAvatarUploadRequest,
    CreateAvatarUploadRequest,
    CreateAvatarUploadResponse,
)
from app.schemas.responses import SuccessResponse
from app.services.auth import rate_limit
from app.services.auth.dependencies import get_current_user
from app.services.avatars.dependencies import get_avatar_api_storage
from app.services.avatars.publisher import CeleryAvatarTaskPublisher, get_avatar_task_publisher
from app.services.avatars.storage import R2AvatarStorage
from app.services.files.avatar import (
    confirm_avatar_upload as confirm_unified_avatar_upload,
)
from app.services.files.avatar import (
    create_avatar_upload as create_unified_avatar_upload,
)
from app.services.files.avatar import (
    get_avatar_upload as get_unified_avatar_upload,
)

router = APIRouter(prefix="/api/v1/auth/me/avatar-uploads", tags=["avatars"])


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[CreateAvatarUploadResponse],
)
async def create_avatar_upload(
    request: Request,
    body: CreateAvatarUploadRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
    storage: Annotated[R2AvatarStorage, Depends(get_avatar_api_storage)],
) -> SuccessResponse[CreateAvatarUploadResponse]:
    result = await create_unified_avatar_upload(
        session,
        redis,
        storage,
        user=user,
        size_bytes=body.size_bytes,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
        content_type=body.content_type,
    )
    return SuccessResponse(data=result)


@router.post(
    "/{upload_id}/confirm",
    response_model=SuccessResponse[AvatarUploadResponse],
    response_model_exclude_none=True,
)
async def confirm_avatar_upload(
    upload_id: str,
    body: ConfirmAvatarUploadRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
    storage: Annotated[R2AvatarStorage, Depends(get_avatar_api_storage)],
    publisher: Annotated[CeleryAvatarTaskPublisher, Depends(get_avatar_task_publisher)],
) -> SuccessResponse[AvatarUploadResponse]:
    result = await confirm_unified_avatar_upload(
        session,
        storage,
        publisher,
        user=user,
        upload_id=upload_id,
        etag=body.etag,
        settings=settings,
    )
    return SuccessResponse(data=result)


@router.get(
    "/{upload_id}",
    response_model=SuccessResponse[AvatarUploadResponse],
    response_model_exclude_none=True,
)
async def get_avatar_upload(
    upload_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[AvatarUploadResponse]:
    return SuccessResponse(
        data=await get_unified_avatar_upload(
            session,
            user=user,
            upload_id=upload_id,
            settings=settings,
        )
    )
