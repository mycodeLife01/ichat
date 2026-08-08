from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.models.user import User
from app.schemas.files import (
    CancelFileUploadsRequest,
    ConfirmFileUploadRequest,
    CreateFileUploadRequest,
    CreateFileUploadResponse,
    FileReadUrlRequest,
    FileReadUrlResponse,
    FileUploadResponse,
    FileUploadStatusRequest,
)
from app.schemas.responses import SuccessResponse
from app.services.auth import rate_limit
from app.services.auth.dependencies import get_current_user
from app.services.files.dependencies import (
    get_file_download_storage,
    get_file_preview_api_storage,
    get_file_upload_storage,
)
from app.services.files.protocols import CompletedPart, FileStorage
from app.services.files.publisher import CeleryFileTaskPublisher, get_file_task_publisher
from app.services.files.service import (
    cancel_upload,
    cancel_uploads,
    confirm_upload,
    create_upload,
    get_upload,
    get_uploads,
    issue_read_url,
)

router = APIRouter(prefix="/api/v1/files", tags=["files"])


@router.post(
    "/uploads",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[CreateFileUploadResponse],
)
async def create_file_upload_route(
    request: Request,
    body: CreateFileUploadRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
    storage: Annotated[FileStorage, Depends(get_file_upload_storage)],
) -> SuccessResponse[CreateFileUploadResponse]:
    result = await create_upload(
        session,
        redis,
        storage,
        user=user,
        filename=body.filename,
        content_type=body.content_type,
        size_bytes=body.size_bytes,
        multipart_supported=body.multipart_supported,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
    return SuccessResponse(data=result)


@router.post(
    "/uploads/status",
    response_model=SuccessResponse[list[FileUploadResponse]],
    response_model_exclude_none=True,
)
async def get_file_uploads_route(
    body: FileUploadStatusRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[list[FileUploadResponse]]:
    return SuccessResponse(
        data=await get_uploads(session, user=user, upload_ids=body.upload_ids)
    )


@router.post(
    "/uploads/cancel",
    response_model=SuccessResponse[list[FileUploadResponse]],
    response_model_exclude_none=True,
)
async def cancel_file_uploads_route(
    body: CancelFileUploadsRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[list[FileUploadResponse]]:
    return SuccessResponse(
        data=await cancel_uploads(session, user=user, upload_ids=body.upload_ids)
    )


@router.post(
    "/uploads/{upload_id}/confirm",
    response_model=SuccessResponse[FileUploadResponse],
    response_model_exclude_none=True,
)
async def confirm_file_upload_route(
    upload_id: UUID,
    body: ConfirmFileUploadRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
    storage: Annotated[FileStorage, Depends(get_file_upload_storage)],
    publisher: Annotated[
        CeleryFileTaskPublisher,
        Depends(get_file_task_publisher),
    ],
) -> SuccessResponse[FileUploadResponse]:
    return SuccessResponse(
        data=await confirm_upload(
            session,
            storage,
            publisher,
            user=user,
            upload_id=upload_id,
            etag=body.etag,
            parts=(
                tuple(
                    CompletedPart(part_number=part.part_number, etag=part.etag)
                    for part in body.parts
                )
                if body.parts is not None
                else None
            ),
            settings=settings,
        )
    )


@router.get(
    "/uploads/{upload_id}",
    response_model=SuccessResponse[FileUploadResponse],
    response_model_exclude_none=True,
)
async def get_file_upload_route(
    upload_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[FileUploadResponse]:
    return SuccessResponse(data=await get_upload(session, user=user, upload_id=upload_id))


@router.delete(
    "/uploads/{upload_id}",
    response_model=SuccessResponse[FileUploadResponse],
    response_model_exclude_none=True,
)
async def cancel_file_upload_route(
    upload_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[FileUploadResponse]:
    return SuccessResponse(data=await cancel_upload(session, user=user, upload_id=upload_id))


@router.post(
    "/{file_id}/read-url",
    response_model=SuccessResponse[FileReadUrlResponse],
)
async def create_file_read_url_route(
    file_id: UUID,
    body: FileReadUrlRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
    storage: Annotated[FileStorage, Depends(get_file_download_storage)],
    preview_storage: Annotated[FileStorage, Depends(get_file_preview_api_storage)],
) -> SuccessResponse[FileReadUrlResponse]:
    return SuccessResponse(
        data=await issue_read_url(
            session,
            storage,
            user=user,
            file_public_id=file_id,
            role=body.role,
            settings=settings,
            preview_storage=preview_storage,
        )
    )
