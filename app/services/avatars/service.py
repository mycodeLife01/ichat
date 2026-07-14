from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from fastapi import status
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.models.avatar import AvatarUpload, AvatarUploadStatus
from app.models.user import User
from app.schemas.avatars import (
    AvatarUploadResponse,
    CreateAvatarUploadResponse,
)
from app.services.auth import rate_limit
from app.services.avatars.storage import (
    AVATAR_CONTENT_TYPE,
    AvatarStorage,
    AvatarTaskPublisher,
    public_avatar_url,
    temporary_object_key,
)

UPLOAD_RATE_MESSAGE = "Too many avatar uploads, please try again later"
STORAGE_UNAVAILABLE_MESSAGE = "Avatar upload is temporarily unavailable"
EMAIL_VERIFICATION_REQUIRED = "Verify your email before uploading an avatar"
INVALID_UPLOAD_MESSAGE = "Avatar upload could not be verified"
UPLOAD_EXPIRED_MESSAGE = "Avatar upload session has expired"

_ERROR_MESSAGES = {
    "invalid_image": "The uploaded image is invalid. Please choose another image.",
    "invalid_dimensions": "The avatar must be a 1024 by 1024 WebP image.",
    "animated_image": "Animated images are not supported.",
    "processing_failed": "Avatar processing failed. Please try again.",
    "upload_expired": UPLOAD_EXPIRED_MESSAGE,
    "superseded": "A newer avatar upload replaced this request.",
    "account_inactive": "This account can no longer publish an avatar.",
}


def _too_many_requests(retry_after_seconds: int) -> AppError:
    return AppError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        UPLOAD_RATE_MESSAGE,
        headers={"Retry-After": str(max(retry_after_seconds, 1))},
    )


async def guard_create_rate_limit(
    redis: Redis, *, user_id: int, client_ip: str, settings: Settings
) -> None:
    try:
        user_result = await rate_limit.check_ip_rate_limit(
            redis,
            f"avatar:rate:user:{user_id}",
            limit=settings.avatar_rate_user_limit,
            window_seconds=settings.avatar_rate_window_seconds,
        )
        if not user_result.allowed:
            raise _too_many_requests(user_result.retry_after_seconds)
        ip_result = await rate_limit.check_ip_rate_limit(
            redis,
            f"avatar:rate:ip:{client_ip}",
            limit=settings.avatar_rate_ip_limit,
            window_seconds=settings.avatar_rate_window_seconds,
        )
        if not ip_result.allowed:
            raise _too_many_requests(ip_result.retry_after_seconds)
    except AppError:
        raise
    except Exception:
        logger.warning("Redis unavailable during avatar upload guard; failing closed")
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, STORAGE_UNAVAILABLE_MESSAGE) from None


async def create_upload(
    session: AsyncSession,
    redis: Redis,
    storage: AvatarStorage,
    *,
    user: User,
    size_bytes: int,
    client_ip: str,
    settings: Settings,
    now: datetime | None = None,
) -> CreateAvatarUploadResponse:
    if not settings.avatar_storage_enabled:
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, STORAGE_UNAVAILABLE_MESSAGE)
    if not user.email_verified:
        raise AppError(status.HTTP_403_FORBIDDEN, EMAIL_VERIFICATION_REQUIRED)
    if size_bytes <= 0 or size_bytes > settings.avatar_upload_max_bytes:
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, "Avatar image is too large")
    await guard_create_rate_limit(redis, user_id=user.id, client_ip=client_ip, settings=settings)

    moment = now or datetime.now(UTC)
    locked_user = await session.scalar(select(User).where(User.id == user.id).with_for_update())
    if locked_user is None or not locked_user.is_active:
        raise AppError(status.HTTP_401_UNAUTHORIZED, "Inactive user")
    await session.execute(
        update(AvatarUpload)
        .where(
            AvatarUpload.user_id == user.id,
            AvatarUpload.is_current.is_(True),
            AvatarUpload.status.in_(
                [AvatarUploadStatus.PENDING, AvatarUploadStatus.QUEUED]
            ),
        )
        .values(
            is_current=False,
            status=AvatarUploadStatus.EXPIRED,
            error_code="superseded",
            completed_at=moment,
        )
    )
    await session.execute(
        update(AvatarUpload)
        .where(
            AvatarUpload.user_id == user.id,
            AvatarUpload.is_current.is_(True),
            AvatarUpload.status == AvatarUploadStatus.PROCESSING,
        )
        .values(is_current=False, error_code="superseded")
    )
    object_key = temporary_object_key()
    upload = AvatarUpload(
        upload_id=str(uuid4()),
        user_id=user.id,
        temporary_object_key=object_key,
        declared_size_bytes=size_bytes,
        status=AvatarUploadStatus.PENDING,
        expires_at=moment + timedelta(seconds=settings.avatar_session_ttl_seconds),
    )
    session.add(upload)
    await session.flush()
    presigned = await asyncio.to_thread(
        storage.presign_upload,
        object_key,
        size_bytes=size_bytes,
        ttl_seconds=settings.avatar_presign_ttl_seconds,
    )
    await session.commit()
    return CreateAvatarUploadResponse(
        upload_id=upload.upload_id,
        upload_url=presigned.url,
        upload_headers=presigned.headers,
        upload_url_expires_at=moment + timedelta(seconds=settings.avatar_presign_ttl_seconds),
        session_expires_at=upload.expires_at,
    )


async def confirm_upload(
    session: AsyncSession,
    storage: AvatarStorage,
    publisher: AvatarTaskPublisher,
    *,
    user: User,
    upload_id: str,
    etag: str,
    settings: Settings,
    now: datetime | None = None,
) -> AvatarUploadResponse:
    moment = now or datetime.now(UTC)
    upload = await session.scalar(
        select(AvatarUpload)
        .where(AvatarUpload.upload_id == upload_id, AvatarUpload.user_id == user.id)
        .with_for_update()
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, "Avatar upload was not found")
    if upload.status != AvatarUploadStatus.PENDING:
        return upload_response(upload, settings=settings)
    if upload.expires_at <= moment or not upload.is_current:
        upload.status = AvatarUploadStatus.EXPIRED
        upload.error_code = "upload_expired" if upload.expires_at <= moment else "superseded"
        upload.completed_at = moment
        await session.commit()
        return upload_response(upload, settings=settings)

    normalized_etag = etag.strip().strip('"')
    try:
        metadata = await asyncio.to_thread(storage.head_temporary, upload.temporary_object_key)
    except Exception:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_UPLOAD_MESSAGE) from None
    if (
        metadata.size_bytes != upload.declared_size_bytes
        or metadata.declared_size_bytes not in (None, upload.declared_size_bytes)
        or metadata.content_type.split(";", 1)[0].strip().lower() != AVATAR_CONTENT_TYPE
        or metadata.etag.strip().strip('"') != normalized_etag
    ):
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_UPLOAD_MESSAGE)

    upload.etag = normalized_etag
    upload.status = AvatarUploadStatus.QUEUED
    upload.queued_at = moment
    await session.commit()
    try:
        publisher.publish(upload.upload_id)
    except Exception:
        logger.warning(
            "Failed to enqueue avatar upload {upload_id}; maintenance will recover",
            upload_id=upload.upload_id,
        )
    return upload_response(upload, settings=settings)


async def get_upload(
    session: AsyncSession, *, user: User, upload_id: str, settings: Settings
) -> AvatarUploadResponse:
    upload = await session.scalar(
        select(AvatarUpload).where(
            AvatarUpload.upload_id == upload_id, AvatarUpload.user_id == user.id
        )
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, "Avatar upload was not found")
    return upload_response(upload, settings=settings)


def upload_response(upload: AvatarUpload, *, settings: Settings) -> AvatarUploadResponse:
    return AvatarUploadResponse(
        upload_id=upload.upload_id,
        status=upload.status,
        error_code=upload.error_code,
        message=_ERROR_MESSAGES.get(upload.error_code or ""),
        avatar_url=(
            public_avatar_url(settings, upload.final_object_key)
            if upload.status == AvatarUploadStatus.SUCCEEDED
            else None
        ),
    )
