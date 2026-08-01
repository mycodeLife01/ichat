from __future__ import annotations

import asyncio
import unicodedata
from datetime import UTC, datetime, timedelta
from pathlib import PurePath
from typing import Literal
from uuid import UUID, uuid4

from fastapi import status
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectRole,
    FilePurpose,
    FileQuota,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
    MessageAttachment,
)
from app.models.user import User
from app.schemas.files import (
    CreateFileUploadResponse,
    FileAssetResponse,
    FileReadUrlResponse,
    FileUploadResponse,
    MessageAttachmentResponse,
)
from app.services.auth import rate_limit
from app.services.files.formats import normalized_extension, validate_upload_declaration
from app.services.files.lifecycle import ACTIVE_UPLOAD_STATUSES, transition_upload
from app.services.files.protocols import FileProcessingError, FileStorage, FileTaskPublisher

UPLOAD_UNAVAILABLE = "File upload is temporarily unavailable"
EMAIL_VERIFICATION_REQUIRED = "Verify your email before uploading files"
UPLOAD_NOT_FOUND = "File upload was not found"
FILE_NOT_FOUND = "File was not found"
INVALID_UPLOAD = "File upload could not be verified"
QUOTA_EXCEEDED = "File storage quota exceeded"
TOO_MANY_INFLIGHT = "Too many files are already being processed"

_ERROR_MESSAGES = {
    "account_inactive": "This account can no longer use the uploaded file.",
    "animated_image": "Animated images are not supported.",
    "clamav_unavailable": "Security scanning is temporarily unavailable.",
    "scanner_unavailable": "Security scanning is temporarily unavailable.",
    "scanner_signatures_stale": "Security scanning is temporarily unavailable.",
    "content_type_mismatch": "The file type does not match its extension.",
    "csv_too_many_columns": "The CSV file has too many columns.",
    "csv_too_many_rows": "The CSV file has too many rows.",
    "csv_column_limit_exceeded": "The CSV file has too many columns.",
    "csv_row_limit_exceeded": "The CSV file has too many rows.",
    "encrypted_document": "Remove the document password locally and upload it again.",
    "file_too_large": "The file is too large.",
    "invalid_encoding": "Convert this file to UTF-8 and upload it again.",
    "invalid_text_encoding": "Convert this file to UTF-8 and upload it again.",
    "invalid_file": "The file is damaged or has an unsupported internal format.",
    "malware_detected": "The file did not pass the security scan.",
    "no_extractable_text": "No readable text was found. OCR is not supported.",
    "nul_byte": "The text file contains unsupported binary data.",
    "nul_byte_not_allowed": "The text file contains unsupported binary data.",
    "processing_failed": "File processing failed. Please try again.",
    "resource_limit": "The file exceeds safe processing limits.",
    "upload_expired": "The upload session has expired.",
    "upload_cancelled": "The upload was cancelled.",
}


def sanitize_filename(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).replace("\\", "/")
    basename = PurePath(normalized).name
    safe = "".join(ch for ch in basename if ch >= " " and ch != "\x7f").strip()
    if not safe or safe in {".", ".."}:
        safe = "file"
    return safe[:255]


def staging_object_key() -> str:
    return f"staging/{uuid4().hex}"


def canonical_object_key(role: str) -> str:
    return f"files/{uuid4().hex}/{role}"


async def guard_create_rate_limit(
    redis: Redis,
    *,
    user_id: int,
    client_ip: str,
    settings: Settings,
) -> None:
    try:
        for key, limit in (
            (f"files:rate:user:{user_id}", settings.files_rate_user_limit),
            (f"files:rate:ip:{client_ip}", settings.files_rate_ip_limit),
        ):
            result = await rate_limit.check_ip_rate_limit(
                redis,
                key,
                limit=limit,
                window_seconds=settings.files_rate_window_seconds,
            )
            if not result.allowed:
                raise AppError(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    "Too many file uploads, please try again later",
                    headers={"Retry-After": str(max(result.retry_after_seconds, 1))},
                )
    except AppError:
        raise
    except Exception:
        logger.warning("Redis unavailable during file upload guard; failing closed")
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE) from None


async def _locked_quota(session: AsyncSession, *, user_id: int) -> FileQuota:
    await session.execute(
        insert(FileQuota).values(user_id=user_id).on_conflict_do_nothing(
            index_elements=[FileQuota.user_id]
        )
    )
    quota = await session.scalar(
        select(FileQuota).where(FileQuota.user_id == user_id).with_for_update()
    )
    if quota is None:
        raise RuntimeError("File quota row is unavailable")
    return quota


async def create_upload(
    session: AsyncSession,
    redis: Redis,
    storage: FileStorage,
    *,
    user: User,
    filename: str,
    content_type: str,
    size_bytes: int,
    client_ip: str,
    settings: Settings,
    purpose: FilePurpose = FilePurpose.MESSAGE_ATTACHMENT,
    now: datetime | None = None,
) -> CreateFileUploadResponse:
    if not settings.file_upload_enabled:
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE)
    if not user.email_verified:
        raise AppError(status.HTTP_403_FORBIDDEN, EMAIL_VERIFICATION_REQUIRED)
    safe_name = sanitize_filename(filename)
    try:
        validate_upload_declaration(
            filename=safe_name,
            content_type=content_type,
            size_bytes=size_bytes,
        )
    except FileProcessingError as exc:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            _ERROR_MESSAGES.get(exc.code, "Unsupported file"),
        ) from None
    await guard_create_rate_limit(
        redis,
        user_id=user.id,
        client_ip=client_ip,
        settings=settings,
    )

    moment = now or datetime.now(UTC)
    locked_user = await session.scalar(select(User).where(User.id == user.id).with_for_update())
    if locked_user is None or not locked_user.is_active:
        raise AppError(status.HTTP_401_UNAUTHORIZED, "Inactive user")
    inflight = await session.scalar(
        select(func.count(FileUpload.id)).where(
            FileUpload.user_id == user.id,
            FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
            FileUpload.status.in_(ACTIVE_UPLOAD_STATUSES),
        )
    )
    if int(inflight or 0) >= settings.files_max_inflight_uploads:
        raise AppError(status.HTTP_409_CONFLICT, TOO_MANY_INFLIGHT)

    quota = await _locked_quota(session, user_id=user.id)
    if quota.used_bytes + quota.reserved_bytes + size_bytes > settings.files_quota_bytes:
        raise AppError(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, QUOTA_EXCEEDED)
    quota.reserved_bytes += size_bytes

    key = staging_object_key()
    upload = FileUpload(
        user_id=user.id,
        purpose=purpose,
        original_filename=safe_name,
        declared_content_type=content_type.split(";", 1)[0].strip().lower(),
        declared_size_bytes=size_bytes,
        staging_object_key=key,
        status=FileUploadStatus.PENDING,
        available_at=moment,
        expires_at=moment + timedelta(seconds=settings.files_upload_session_ttl_seconds),
    )
    session.add(upload)
    await session.flush()
    try:
        signed = await asyncio.to_thread(
            storage.presign_upload,
            key,
            size_bytes=size_bytes,
            ttl_seconds=settings.files_upload_presign_ttl_seconds,
            content_type=upload.declared_content_type,
        )
    except Exception:
        await session.rollback()
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE) from None
    await session.commit()
    return CreateFileUploadResponse(
        upload_id=upload.public_id,
        status="pending",
        upload_url=signed.url,
        upload_headers=dict(signed.headers),
        upload_url_expires_at=moment
        + timedelta(seconds=settings.files_upload_presign_ttl_seconds),
        session_expires_at=upload.expires_at,
    )


async def confirm_upload(
    session: AsyncSession,
    storage: FileStorage,
    publisher: FileTaskPublisher,
    *,
    user: User,
    upload_id: UUID,
    etag: str,
    settings: Settings,
    now: datetime | None = None,
) -> FileUploadResponse:
    moment = now or datetime.now(UTC)
    upload = await session.scalar(
        select(FileUpload)
        .where(FileUpload.public_id == upload_id, FileUpload.user_id == user.id)
        .with_for_update()
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, UPLOAD_NOT_FOUND)
    normalized_etag = etag.strip().strip('"')
    if upload.status != FileUploadStatus.PENDING:
        if upload.confirmed_etag is not None and upload.confirmed_etag != normalized_etag:
            raise AppError(status.HTTP_409_CONFLICT, "The confirmed upload cannot be replaced")
        return await upload_response(session, upload)
    if upload.expires_at <= moment:
        quota = await _locked_quota(session, user_id=user.id)
        quota.reserved_bytes = max(0, quota.reserved_bytes - upload.declared_size_bytes)
        transition_upload(
            upload,
            FileUploadStatus.EXPIRED,
            now=moment,
            error_code="upload_expired",
        )
        await session.commit()
        return await upload_response(session, upload)

    try:
        metadata = await asyncio.to_thread(storage.head_staging, upload.staging_object_key)
    except Exception:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_UPLOAD) from None
    actual_type = metadata.content_type.split(";", 1)[0].strip().lower()
    if (
        metadata.size_bytes != upload.declared_size_bytes
        or metadata.declared_size_bytes != upload.declared_size_bytes
        or actual_type != upload.declared_content_type
        or metadata.etag.strip().strip('"') != normalized_etag
    ):
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_UPLOAD)

    upload.confirmed_etag = normalized_etag
    transition_upload(upload, FileUploadStatus.QUEUED, now=moment)
    await session.commit()
    try:
        publisher.publish(str(upload.public_id))
    except Exception:
        logger.bind(upload_id=str(upload.public_id)).warning(
            "File upload wakeup failed; maintenance sweep will recover"
        )
    return await upload_response(session, upload)


async def get_upload(
    session: AsyncSession,
    *,
    user: User,
    upload_id: UUID,
) -> FileUploadResponse:
    upload = await session.scalar(
        select(FileUpload).where(
            FileUpload.public_id == upload_id,
            FileUpload.user_id == user.id,
        )
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, UPLOAD_NOT_FOUND)
    return await upload_response(session, upload)


async def get_uploads(
    session: AsyncSession,
    *,
    user: User,
    upload_ids: list[UUID],
) -> list[FileUploadResponse]:
    rows = list(
        (
            await session.scalars(
                select(FileUpload).where(
                    FileUpload.user_id == user.id,
                    FileUpload.public_id.in_(upload_ids),
                )
            )
        ).all()
    )
    by_id = {row.public_id: row for row in rows}
    if len(by_id) != len(upload_ids):
        raise AppError(status.HTTP_404_NOT_FOUND, UPLOAD_NOT_FOUND)
    return [await upload_response(session, by_id[upload_id]) for upload_id in upload_ids]


async def cancel_upload(
    session: AsyncSession,
    *,
    user: User,
    upload_id: UUID,
    now: datetime | None = None,
) -> FileUploadResponse:
    moment = now or datetime.now(UTC)
    upload = await session.scalar(
        select(FileUpload)
        .where(FileUpload.public_id == upload_id, FileUpload.user_id == user.id)
        .with_for_update()
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, UPLOAD_NOT_FOUND)
    if upload.status == FileUploadStatus.CANCELLED:
        return await upload_response(session, upload)
    if upload.status == FileUploadStatus.SUCCEEDED:
        file = (
            await session.scalar(
                select(FileAsset).where(FileAsset.id == upload.file_id).with_for_update()
            )
            if upload.file_id is not None
            else None
        )
        if file is not None and file.bound_at is not None:
            raise AppError(status.HTTP_409_CONFLICT, "A bound attachment cannot be cancelled")
        if file is not None and file.deletion_started_at is None:
            await begin_file_deletion(session, file=file, now=moment)
        await session.commit()
        return await upload_response(session, upload)
    if upload.status in {
        FileUploadStatus.REJECTED,
        FileUploadStatus.FAILED,
        FileUploadStatus.EXPIRED,
    }:
        return await upload_response(session, upload)

    quota = await _locked_quota(session, user_id=user.id)
    quota.reserved_bytes = max(0, quota.reserved_bytes - upload.declared_size_bytes)
    transition_upload(
        upload,
        FileUploadStatus.CANCELLED,
        now=moment,
        error_code="upload_cancelled",
    )
    await session.commit()
    return await upload_response(session, upload)


async def upload_response(
    session: AsyncSession,
    upload: FileUpload,
) -> FileUploadResponse:
    file_response: FileAssetResponse | None = None
    if upload.file_id is not None:
        file = await session.get(FileAsset, upload.file_id)
        if file is not None and file.deletion_started_at is None:
            file_response = await asset_response(session, file)
    return FileUploadResponse(
        upload_id=upload.public_id,
        status=upload.status.value,
        error_code=upload.error_code,
        message=_ERROR_MESSAGES.get(upload.error_code or ""),
        file=file_response,
    )


async def asset_response(session: AsyncSession, file: FileAsset) -> FileAssetResponse:
    preview = await session.scalar(
        select(FileObject.id).where(
            FileObject.file_id == file.id,
            FileObject.role == FileObjectRole.PREVIEW,
        )
    )
    return FileAssetResponse(
        id=file.public_id,
        name=file.original_filename,
        media_type=file.media_type,
        size_bytes=file.size_bytes,
        category=file_category(file),
        model_consumable=file.model_consumable,
        warnings=list(file.warnings or []),
        preview_available=preview is not None,
        unbound_expires_at=file.unbound_expires_at if file.bound_at is None else None,
        stats={
            key: value
            for key, value in (file.summary_metadata or {}).items()
            if isinstance(value, int | str)
        },
    )


def file_category(file: FileAsset) -> Literal["image", "pdf", "office", "text"]:
    return file_category_values(file.original_filename, file.media_type)


def file_category_values(
    filename: str,
    media_type: str,
) -> Literal["image", "pdf", "office", "text"]:
    if media_type.startswith("image/"):
        return "image"
    if media_type == "application/pdf":
        return "pdf"
    if normalized_extension(filename) in {"docx", "pptx", "xlsx"}:
        return "office"
    return "text"


async def attachment_responses(
    session: AsyncSession,
    *,
    message_ids: list[int],
) -> dict[int, list[MessageAttachmentResponse]]:
    if not message_ids:
        return {}
    rows = (
        await session.execute(
            select(MessageAttachment, FileAsset)
            .outerjoin(FileAsset, FileAsset.id == MessageAttachment.file_id)
            .where(MessageAttachment.message_id.in_(message_ids))
            .order_by(MessageAttachment.message_id, MessageAttachment.position)
        )
    ).all()
    result: dict[int, list[MessageAttachmentResponse]] = {}
    for attachment, file in rows:
        media_type = attachment.media_type
        name = attachment.name
        preview_available = False
        public_id = file.public_id if file is not None else UUID(int=0)
        if file is not None:
            preview_available = (
                await session.scalar(
                    select(FileObject.id).where(
                        FileObject.file_id == file.id,
                        FileObject.role == FileObjectRole.PREVIEW,
                    )
                )
                is not None
            )
        result.setdefault(attachment.message_id, []).append(
            MessageAttachmentResponse(
                id=public_id,
                name=name,
                media_type=media_type,
                size_bytes=attachment.size_bytes,
                category=file_category_values(name, media_type),
                model_consumable=file.model_consumable if file is not None else False,
                warnings=list(attachment.warnings or []),
                preview_available=preview_available,
                position=attachment.position,
            )
        )
    return result


async def issue_read_url(
    session: AsyncSession,
    storage: FileStorage,
    *,
    user: User,
    file_public_id: UUID,
    role: str,
    settings: Settings,
    now: datetime | None = None,
) -> FileReadUrlResponse:
    moment = now or datetime.now(UTC)
    active_user_id = await session.scalar(
        select(User.id)
        .where(User.id == user.id, User.is_active.is_(True))
        .with_for_update(read=True)
    )
    if active_user_id is None:
        raise AppError(status.HTTP_404_NOT_FOUND, FILE_NOT_FOUND)
    file = await session.scalar(
        select(FileAsset).where(
            FileAsset.public_id == file_public_id,
            FileAsset.user_id == user.id,
            FileAsset.purpose == FilePurpose.MESSAGE_ATTACHMENT,
            FileAsset.deletion_started_at.is_(None),
        )
    )
    if file is None:
        raise AppError(status.HTTP_404_NOT_FOUND, FILE_NOT_FOUND)
    if file.bound_at is None:
        if file.unbound_expires_at is None or file.unbound_expires_at <= moment:
            raise AppError(status.HTTP_404_NOT_FOUND, FILE_NOT_FOUND)
    else:
        visible = await session.scalar(
            select(MessageAttachment.id)
            .join(Message, Message.id == MessageAttachment.message_id)
            .join(Conversation, Conversation.id == Message.conversation_id)
            .where(
                MessageAttachment.file_id == file.id,
                Message.archived_at.is_(None),
                Conversation.user_id == user.id,
                Conversation.deleted_at.is_(None),
            )
            .limit(1)
        )
        if visible is None:
            raise AppError(status.HTTP_404_NOT_FOUND, FILE_NOT_FOUND)

    object_role = FileObjectRole.PREVIEW if role == "preview" else FileObjectRole.ORIGINAL
    object_row = await session.scalar(
        select(FileObject).where(
            FileObject.file_id == file.id,
            FileObject.role == object_role,
            FileObject.storage_location == FileStorageLocation.CANONICAL_PRIVATE,
        )
    )
    if object_row is None:
        raise AppError(status.HTTP_404_NOT_FOUND, FILE_NOT_FOUND)
    expires_at = moment + timedelta(seconds=settings.files_download_ttl_seconds)
    try:
        signed = await asyncio.to_thread(
            storage.presign_download,
            object_row.object_key,
            ttl_seconds=settings.files_download_ttl_seconds,
            disposition="inline" if role == "preview" else "attachment",
            filename=file.original_filename,
        )
    except Exception:
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE) from None
    return FileReadUrlResponse(url=signed.url, expires_at=expires_at)


async def begin_file_deletion(
    session: AsyncSession,
    *,
    file: FileAsset,
    now: datetime,
) -> None:
    """Mark an asset deleting and persist every external-object compensation."""

    from app.models.files import FileObjectDeletion

    if file.deletion_started_at is not None:
        return
    file.deletion_started_at = now
    objects = list(
        (
            await session.scalars(select(FileObject).where(FileObject.file_id == file.id))
        ).all()
    )
    for object_row in objects:
        session.add(
            FileObjectDeletion(
                file_object_id=object_row.id,
                storage_location=object_row.storage_location,
                object_key=object_row.object_key,
                available_at=now,
            )
        )
    if file.purpose == FilePurpose.MESSAGE_ATTACHMENT:
        quota = await _locked_quota(session, user_id=file.user_id)
        quota.used_bytes = max(0, quota.used_bytes - file.size_bytes)
    await session.flush()
