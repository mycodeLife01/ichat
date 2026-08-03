"""Avatar-purpose workflow owned by the unified files domain.

The public HTTP route intentionally remains under ``/auth/me/avatar-uploads``.
This module is its domain implementation: it uses the shared upload/asset/object
rows while retaining avatar-only public storage and CDN-purge behaviour.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import UUID, uuid4

from fastapi import status
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.errors import AppError
from app.models.avatar import AvatarUpload, AvatarUploadStatus
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
)
from app.models.user import User
from app.schemas.avatars import (
    AvatarUploadResponse,
    CreateAvatarUploadResponse,
)
from app.services.avatars.processing import PermanentAvatarError, render_avatar
from app.services.avatars.storage import (
    ALLOWED_UPLOAD_CONTENT_TYPES,
    AVATAR_CONTENT_TYPE,
    AvatarStorage,
    AvatarTaskPublisher,
    public_avatar_url,
    public_object_key,
    temporary_object_key,
)
from app.services.files.lifecycle import retry_available_at, transition_upload

UPLOAD_RATE_MESSAGE = "Too many avatar uploads, please try again later"
STORAGE_UNAVAILABLE_MESSAGE = "Avatar upload is temporarily unavailable"
EMAIL_VERIFICATION_REQUIRED = "Verify your email before uploading an avatar"
INVALID_UPLOAD_MESSAGE = "Avatar upload could not be verified"

_ERROR_MESSAGES = {
    "account_inactive": "This account can no longer publish an avatar.",
    "animated_image": "Animated images are not supported.",
    "invalid_image": "The uploaded image is invalid. Please choose another image.",
    "invalid_dimensions": "The avatar must be a 1024 by 1024 image.",
    "processing_failed": "Avatar processing failed. Please try again.",
    "superseded": "A newer avatar upload replaced this request.",
    "upload_cancelled": "A newer avatar upload replaced this request.",
    "upload_expired": "Avatar upload session has expired.",
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
    """Keep the frozen avatar rate-limit contract, failing closed on Redis loss."""

    from app.services.auth import rate_limit

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


def _parse_upload_id(upload_id: str) -> UUID:
    try:
        return UUID(upload_id)
    except ValueError:
        raise AppError(status.HTTP_404_NOT_FOUND, "Avatar upload was not found") from None


async def create_avatar_upload(
    session: AsyncSession,
    redis: Redis,
    storage: AvatarStorage,
    *,
    user: User,
    size_bytes: int,
    client_ip: str,
    settings: Settings,
    content_type: str = AVATAR_CONTENT_TYPE,
    now: datetime | None = None,
) -> CreateAvatarUploadResponse:
    """Create a unified avatar upload without reserving attachment quota."""

    if not settings.avatar_storage_enabled:
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, STORAGE_UNAVAILABLE_MESSAGE)
    if not user.email_verified:
        raise AppError(status.HTTP_403_FORBIDDEN, EMAIL_VERIFICATION_REQUIRED)
    if size_bytes <= 0 or size_bytes > settings.avatar_upload_max_bytes:
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, "Avatar image is too large")
    if content_type not in ALLOWED_UPLOAD_CONTENT_TYPES:
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, "Avatar image type is not supported")
    await guard_create_rate_limit(redis, user_id=user.id, client_ip=client_ip, settings=settings)

    moment = now or datetime.now(UTC)
    locked_user = await session.scalar(select(User).where(User.id == user.id).with_for_update())
    if locked_user is None or not locked_user.is_active:
        raise AppError(status.HTTP_401_UNAUTHORIZED, "Inactive user")

    # New writes have one source of truth. Marking legacy sessions non-current
    # prevents an old draining media task from winning a later replacement race.
    await session.execute(
        update(FileUpload)
        .where(
            FileUpload.user_id == user.id,
            FileUpload.purpose == FilePurpose.AVATAR,
            FileUpload.status.in_(
                [
                    FileUploadStatus.PENDING,
                    FileUploadStatus.QUEUED,
                    FileUploadStatus.PROCESSING,
                ]
            ),
        )
        .values(
            status=FileUploadStatus.CANCELLED,
            error_code="superseded",
            completed_at=moment,
            lease_owner=None,
            lease_expires_at=None,
        )
    )
    await session.execute(
        update(AvatarUpload)
        .where(
            AvatarUpload.user_id == user.id,
            AvatarUpload.is_current.is_(True),
            AvatarUpload.status.in_(
                [
                    AvatarUploadStatus.PENDING,
                    AvatarUploadStatus.QUEUED,
                    AvatarUploadStatus.PROCESSING,
                ]
            ),
        )
        .values(
            is_current=False,
            status=AvatarUploadStatus.EXPIRED,
            error_code="superseded",
            completed_at=moment,
            lease_owner=None,
            lease_expires_at=None,
        )
    )

    key = temporary_object_key(content_type)
    upload = FileUpload(
        user_id=user.id,
        purpose=FilePurpose.AVATAR,
        # The browser-cropped blob has no meaningful source filename. Keep a
        # stable, non-user-controlled logical name for the avatar asset.
        original_filename="avatar.webp",
        declared_content_type=content_type,
        declared_size_bytes=size_bytes,
        staging_object_key=key,
        status=FileUploadStatus.PENDING,
        available_at=moment,
        expires_at=moment + timedelta(seconds=settings.avatar_session_ttl_seconds),
    )
    session.add(upload)
    await session.flush()
    try:
        signed = await asyncio.to_thread(
            storage.presign_upload,
            key,
            size_bytes=size_bytes,
            ttl_seconds=settings.avatar_presign_ttl_seconds,
            content_type=content_type,
        )
    except Exception:
        await session.rollback()
        raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, STORAGE_UNAVAILABLE_MESSAGE) from None
    await session.commit()
    return CreateAvatarUploadResponse(
        upload_id=str(upload.public_id),
        upload_url=signed.url,
        upload_headers=dict(signed.headers),
        upload_url_expires_at=moment + timedelta(seconds=settings.avatar_presign_ttl_seconds),
        session_expires_at=upload.expires_at,
    )


async def confirm_avatar_upload(
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
    public_id = _parse_upload_id(upload_id)
    upload = await session.scalar(
        select(FileUpload)
        .where(
            FileUpload.public_id == public_id,
            FileUpload.user_id == user.id,
            FileUpload.purpose == FilePurpose.AVATAR,
        )
        .with_for_update()
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, "Avatar upload was not found")
    normalized_etag = etag.strip().strip('"')
    if upload.status != FileUploadStatus.PENDING:
        if upload.confirmed_etag is not None and upload.confirmed_etag != normalized_etag:
            raise AppError(status.HTTP_409_CONFLICT, "The confirmed upload cannot be replaced")
        return await avatar_upload_response(session, upload, settings=settings)
    if upload.expires_at <= moment:
        transition_upload(
            upload,
            FileUploadStatus.EXPIRED,
            now=moment,
            error_code="upload_expired",
        )
        await session.commit()
        return await avatar_upload_response(session, upload, settings=settings)

    try:
        metadata = await asyncio.to_thread(storage.head_temporary, upload.staging_object_key)
    except Exception:
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_UPLOAD_MESSAGE) from None
    actual_type = metadata.content_type.split(";", 1)[0].strip().lower()
    if (
        metadata.size_bytes != upload.declared_size_bytes
        or metadata.declared_size_bytes not in (None, upload.declared_size_bytes)
        or actual_type != upload.declared_content_type
        or actual_type not in ALLOWED_UPLOAD_CONTENT_TYPES
        or metadata.etag.strip().strip('"') != normalized_etag
    ):
        raise AppError(status.HTTP_400_BAD_REQUEST, INVALID_UPLOAD_MESSAGE)

    upload.confirmed_etag = normalized_etag
    transition_upload(upload, FileUploadStatus.QUEUED, now=moment)
    await session.commit()
    try:
        publisher.publish(str(upload.public_id))
    except Exception:
        logger.bind(upload_id=str(upload.public_id)).warning(
            "Avatar upload wakeup failed; maintenance sweep will recover"
        )
    return await avatar_upload_response(session, upload, settings=settings)


async def get_avatar_upload(
    session: AsyncSession,
    *,
    user: User,
    upload_id: str,
    settings: Settings,
) -> AvatarUploadResponse:
    public_id = _parse_upload_id(upload_id)
    upload = await session.scalar(
        select(FileUpload).where(
            FileUpload.public_id == public_id,
            FileUpload.user_id == user.id,
            FileUpload.purpose == FilePurpose.AVATAR,
        )
    )
    if upload is None:
        raise AppError(status.HTTP_404_NOT_FOUND, "Avatar upload was not found")
    return await avatar_upload_response(session, upload, settings=settings)


def _legacy_response_status(status_value: FileUploadStatus) -> AvatarUploadStatus:
    # The route's response enum predates ``rejected`` and ``cancelled``. Keep
    # the external contract stable while preserving the exact internal code.
    if status_value in {FileUploadStatus.REJECTED, FileUploadStatus.CANCELLED}:
        return AvatarUploadStatus.FAILED
    return AvatarUploadStatus(status_value.value)


async def avatar_upload_response(
    session: AsyncSession,
    upload: FileUpload,
    *,
    settings: Settings,
) -> AvatarUploadResponse:
    object_key: str | None = None
    if upload.status == FileUploadStatus.SUCCEEDED and upload.file_id is not None:
        object_key = await session.scalar(
            select(FileObject.object_key).where(
                FileObject.file_id == upload.file_id,
                FileObject.role == FileObjectRole.AVATAR_512,
                FileObject.storage_location == FileStorageLocation.AVATAR_PUBLIC,
            )
        )
    return AvatarUploadResponse(
        upload_id=str(upload.public_id),
        status=_legacy_response_status(upload.status),
        error_code=upload.error_code,
        message=_ERROR_MESSAGES.get(upload.error_code or ""),
        avatar_url=public_avatar_url(settings, object_key),
    )


async def avatar_url_for_user(
    session: AsyncSession,
    *,
    user: User,
    settings: Settings,
) -> str | None:
    """Resolve the new FK first, then retain the legacy object-key fallback."""

    if user.avatar_file_id is not None:
        object_key = await session.scalar(
            select(FileObject.object_key)
            .join(FileAsset, FileAsset.id == FileObject.file_id)
            .where(
                FileAsset.id == user.avatar_file_id,
                FileAsset.purpose == FilePurpose.AVATAR,
                FileAsset.deletion_started_at.is_(None),
                FileObject.role == FileObjectRole.AVATAR_512,
                FileObject.storage_location == FileStorageLocation.AVATAR_PUBLIC,
            )
        )
        if object_key is not None:
            return public_avatar_url(settings, object_key)
    return public_avatar_url(settings, user.avatar_object_key)


def _purge_url(settings: Settings, object_key: str) -> str:
    purge_url = public_avatar_url(settings, object_key)
    if purge_url is None:
        raise RuntimeError("Avatar public base URL is required")
    return purge_url


def _enqueue_avatar_deletion(
    session: Session,
    *,
    settings: Settings,
    object_key: str,
    now: datetime,
    file_object_id: int | None = None,
) -> None:
    existing = session.scalar(
        select(FileObjectDeletion.id).where(
            FileObjectDeletion.storage_location == FileStorageLocation.AVATAR_PUBLIC,
            FileObjectDeletion.object_key == object_key,
        )
    )
    if existing is None:
        session.add(
            FileObjectDeletion(
                file_object_id=file_object_id,
                storage_location=FileStorageLocation.AVATAR_PUBLIC,
                object_key=object_key,
                purge_url=_purge_url(settings, object_key),
                available_at=now,
            )
        )


def _enqueue_avatar_manifest_deletions(
    session: Session,
    *,
    upload: FileUpload,
    settings: Settings,
    now: datetime,
) -> None:
    for entry in upload.output_manifest or []:
        if entry.get("role") != FileObjectRole.AVATAR_512.value:
            continue
        object_key = str(entry.get("object_key") or "")
        if object_key:
            _enqueue_avatar_deletion(
                session,
                settings=settings,
                object_key=object_key,
                now=now,
            )


def _begin_avatar_asset_deletion(
    session: Session,
    *,
    file: FileAsset,
    settings: Settings,
    now: datetime,
) -> None:
    if file.deletion_started_at is not None:
        return
    file.deletion_started_at = now
    for object_row in session.scalars(select(FileObject).where(FileObject.file_id == file.id)):
        _enqueue_avatar_deletion(
            session,
            settings=settings,
            object_key=object_row.object_key,
            now=now,
            file_object_id=object_row.id,
        )


def process_avatar_upload(
    factory: sessionmaker[Session],
    *,
    upload_id: str,
    settings: Settings,
    storage: AvatarStorage,
    task_id: str | None = None,
    now: datetime | None = None,
) -> str:
    """Claim and render one unified avatar upload on the media worker."""

    moment = now or datetime.now(UTC)
    owner = task_id or uuid4().hex
    try:
        public_id = UUID(upload_id)
    except ValueError:
        return "missing"

    with factory() as session:
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if upload is None or upload.purpose != FilePurpose.AVATAR:
            return "missing"
        if upload.status == FileUploadStatus.SUCCEEDED:
            return "succeeded"
        user = session.get(User, upload.user_id)
        if (
            upload.status != FileUploadStatus.QUEUED
            or upload.available_at > moment
            or upload.confirmed_etag is None
            or user is None
            or not user.is_active
        ):
            return "not_claimable"
        transition_upload(upload, FileUploadStatus.PROCESSING, now=moment)
        upload.attempt_count += 1
        upload.lease_owner = owner
        upload.lease_expires_at = moment + timedelta(
            seconds=settings.avatar_processing_lease_seconds
        )
        staging_key = upload.staging_object_key
        etag = upload.confirmed_etag
        declared_size = upload.declared_size_bytes
        attempt_count = upload.attempt_count
        existing_manifest = list(upload.output_manifest or [])
        session.commit()

    try:
        source = storage.get_temporary(staging_key, if_match=etag)
        if len(source) != declared_size:
            raise PermanentAvatarError("invalid_image")
        rendered = render_avatar(source, max_bytes=settings.avatar_upload_max_bytes)
        rendered_hash = sha256(rendered).hexdigest()
        manifest = existing_manifest or [
            {
                "role": FileObjectRole.AVATAR_512.value,
                "object_key": public_object_key(),
                "media_type": AVATAR_CONTENT_TYPE,
                "size_bytes": len(rendered),
                "sha256": rendered_hash,
            }
        ]
        _persist_avatar_manifest(factory, public_id=public_id, owner=owner, manifest=manifest)
        storage.put_public(str(manifest[0]["object_key"]), rendered)
    except PermanentAvatarError as exc:
        return _finish_avatar_error(
            factory,
            public_id=public_id,
            owner=owner,
            settings=settings,
            code=exc.code,
            retryable=False,
            attempt_count=attempt_count,
            now=moment,
        )
    except Exception:
        return _finish_avatar_error(
            factory,
            public_id=public_id,
            owner=owner,
            settings=settings,
            code="processing_failed",
            retryable=True,
            attempt_count=attempt_count,
            now=moment,
        )

    result = _commit_avatar_success(
        factory,
        public_id=public_id,
        owner=owner,
        manifest=manifest,
        settings=settings,
        now=moment,
    )
    try:
        storage.delete_temporary(staging_key)
    except Exception:
        return result
    with factory() as session:
        current = session.scalar(select(FileUpload).where(FileUpload.public_id == public_id))
        if current is not None:
            current.staging_deleted_at = datetime.now(UTC)
            session.commit()
    return result


def _persist_avatar_manifest(
    factory: sessionmaker[Session],
    *,
    public_id: UUID,
    owner: str,
    manifest: list[dict[str, object]],
) -> None:
    with factory() as session:
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if (
            upload is None
            or upload.purpose != FilePurpose.AVATAR
            or upload.status != FileUploadStatus.PROCESSING
            or upload.lease_owner != owner
        ):
            raise PermanentAvatarError("upload_cancelled")
        if upload.output_manifest is not None and upload.output_manifest != manifest:
            raise PermanentAvatarError("processing_failed")
        upload.output_manifest = manifest
        session.commit()


def _finish_avatar_error(
    factory: sessionmaker[Session],
    *,
    public_id: UUID,
    owner: str,
    settings: Settings,
    code: str,
    retryable: bool,
    attempt_count: int,
    now: datetime,
) -> str:
    with factory() as session:
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if upload is None:
            return "missing"
        if upload.status != FileUploadStatus.PROCESSING or upload.lease_owner != owner:
            return "cancelled"
        if retryable and attempt_count < settings.avatar_processing_max_attempts:
            transition_upload(upload, FileUploadStatus.QUEUED, now=now)
            upload.available_at = retry_available_at(attempt_count=attempt_count, now=now)
            upload.error_code = None
            session.commit()
            return "retry"
        transition_upload(
            upload,
            FileUploadStatus.FAILED if retryable else FileUploadStatus.REJECTED,
            now=now,
            error_code=code,
        )
        _enqueue_avatar_manifest_deletions(session, upload=upload, settings=settings, now=now)
        session.commit()
        return "failed" if retryable else "rejected"


def _commit_avatar_success(
    factory: sessionmaker[Session],
    *,
    public_id: UUID,
    owner: str,
    manifest: list[dict[str, object]],
    settings: Settings,
    now: datetime,
) -> str:
    with factory() as session:
        # Account deactivation locks User then FileUpload. Mirror that order
        # here; the first read only identifies the immutable owner id.
        observed = session.scalar(select(FileUpload).where(FileUpload.public_id == public_id))
        if observed is None:
            return "orphaned"
        user = session.scalar(select(User).where(User.id == observed.user_id).with_for_update())
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if upload is None:
            return "orphaned"
        if (
            upload.status != FileUploadStatus.PROCESSING
            or upload.lease_owner != owner
            or user is None
            or not user.is_active
        ):
            _enqueue_avatar_manifest_deletions(session, upload=upload, settings=settings, now=now)
            if upload.status == FileUploadStatus.PROCESSING and upload.lease_owner == owner:
                transition_upload(
                    upload,
                    FileUploadStatus.CANCELLED,
                    now=now,
                    error_code=(
                        "account_inactive"
                        if user is None or not user.is_active
                        else "upload_cancelled"
                    ),
                )
            session.commit()
            return "cancelled"

        entry = manifest[0]
        rendered_size = _manifest_size(entry)
        asset = FileAsset(
            user_id=upload.user_id,
            purpose=FilePurpose.AVATAR,
            original_filename="avatar.webp",
            media_type=AVATAR_CONTENT_TYPE,
            size_bytes=rendered_size,
            sha256=str(entry["sha256"]),
            warnings=[],
            extractor_version="avatar-v1",
            summary_metadata={"width": 512, "height": 512},
            model_input_kind=None,
        )
        session.add(asset)
        session.flush()
        object_row = FileObject(
            file_id=asset.id,
            role=FileObjectRole.AVATAR_512,
            storage_location=FileStorageLocation.AVATAR_PUBLIC,
            object_key=str(entry["object_key"]),
            media_type=AVATAR_CONTENT_TYPE,
            size_bytes=rendered_size,
            sha256=str(entry["sha256"]),
        )
        session.add(object_row)
        session.flush()

        old_file_id = user.avatar_file_id
        old_key = user.avatar_object_key
        user.avatar_file_id = asset.id
        # New writes do not persist the legacy key. It stays read-only fallback
        # for rows not yet imported by the expand migration.
        user.avatar_object_key = None
        upload.file_id = asset.id
        transition_upload(upload, FileUploadStatus.SUCCEEDED, now=now)

        if old_file_id is not None and old_file_id != asset.id:
            old_file = session.scalar(
                select(FileAsset).where(FileAsset.id == old_file_id).with_for_update()
            )
            if old_file is not None:
                _begin_avatar_asset_deletion(session, file=old_file, settings=settings, now=now)
        elif old_key is not None and old_key != object_row.object_key:
            _enqueue_avatar_deletion(session, settings=settings, object_key=old_key, now=now)
        session.commit()
        return "succeeded"


def _manifest_size(entry: dict[str, object]) -> int:
    value = entry.get("size_bytes")
    if not isinstance(value, int):
        raise RuntimeError("Avatar output manifest is invalid")
    return value


def sweep_avatar_uploads(
    session: Session,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> list[str]:
    """Recover only unified avatar rows; legacy rows keep their old drain path."""

    moment = now or datetime.now(UTC)
    batch = settings.avatar_maintenance_batch_size
    processing = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.AVATAR,
                FileUpload.status == FileUploadStatus.PROCESSING,
                FileUpload.lease_expires_at <= moment,
            )
            .order_by(FileUpload.lease_expires_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    for upload in processing:
        if upload.attempt_count >= settings.avatar_processing_max_attempts:
            transition_upload(
                upload,
                FileUploadStatus.FAILED,
                now=moment,
                error_code="processing_failed",
            )
            _enqueue_avatar_manifest_deletions(
                session,
                upload=upload,
                settings=settings,
                now=moment,
            )
        else:
            transition_upload(upload, FileUploadStatus.QUEUED, now=moment)
            upload.available_at = retry_available_at(attempt_count=upload.attempt_count, now=moment)

    pending = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.AVATAR,
                FileUpload.status == FileUploadStatus.PENDING,
                FileUpload.expires_at <= moment,
            )
            .order_by(FileUpload.expires_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    for upload in pending:
        transition_upload(
            upload,
            FileUploadStatus.EXPIRED,
            now=moment,
            error_code="upload_expired",
        )

    dirty_terminal = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.AVATAR,
                FileUpload.status.in_(
                    [
                        FileUploadStatus.CANCELLED,
                        FileUploadStatus.REJECTED,
                        FileUploadStatus.FAILED,
                        FileUploadStatus.EXPIRED,
                    ]
                ),
                FileUpload.output_manifest.is_not(None),
            )
            .order_by(FileUpload.completed_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    for upload in dirty_terminal:
        _enqueue_avatar_manifest_deletions(session, upload=upload, settings=settings, now=moment)
        upload.output_manifest = None

    due = list(
        session.scalars(
            select(FileUpload.public_id)
            .where(
                FileUpload.purpose == FilePurpose.AVATAR,
                FileUpload.status == FileUploadStatus.QUEUED,
                FileUpload.available_at <= moment,
            )
            .order_by(FileUpload.available_at)
            .limit(batch)
        )
    )
    session.flush()
    return [str(value) for value in due]


def cleanup_avatar_staging_objects(
    session: Session,
    *,
    settings: Settings,
    storage: AvatarStorage,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    threshold = moment - timedelta(seconds=settings.avatar_cleanup_safety_seconds)
    rows = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.AVATAR,
                FileUpload.completed_at.is_not(None),
                FileUpload.completed_at <= threshold,
                FileUpload.staging_deleted_at.is_(None),
                FileUpload.status.in_(
                    [
                        FileUploadStatus.SUCCEEDED,
                        FileUploadStatus.REJECTED,
                        FileUploadStatus.FAILED,
                        FileUploadStatus.EXPIRED,
                        FileUploadStatus.CANCELLED,
                    ]
                ),
            )
            .order_by(FileUpload.completed_at)
            .limit(settings.avatar_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    cleaned = 0
    for upload in rows:
        try:
            storage.delete_temporary(upload.staging_object_key)
        except Exception:
            continue
        upload.staging_deleted_at = moment
        cleaned += 1
    session.flush()
    return cleaned


async def deactivate_user_avatar(
    session: AsyncSession,
    *,
    user: User,
    settings: Settings,
    now: datetime | None = None,
) -> None:
    """Compatibility name for the account-wide unified-files deactivation."""

    from app.services.files.account import deactivate_user_files

    await deactivate_user_files(session, user=user, settings=settings, now=now)


async def take_down_user_avatar(
    session: AsyncSession,
    *,
    user: User,
    settings: Settings,
    now: datetime | None = None,
) -> bool:
    """Remove a current avatar through the same durable compensation path."""

    if user.avatar_file_id is None and user.avatar_object_key is None:
        return False
    moment = now or datetime.now(UTC)
    file = None
    if user.avatar_file_id is not None:
        file = await session.scalar(
            select(FileAsset).where(FileAsset.id == user.avatar_file_id).with_for_update()
        )
    fallback_key = user.avatar_object_key
    user.avatar_file_id = None
    user.avatar_object_key = None
    if file is not None:
        await _begin_avatar_asset_deletion_async(session, file=file, settings=settings, now=moment)
    elif fallback_key is not None:
        await _enqueue_avatar_deletion_async(
            session, settings=settings, object_key=fallback_key, now=moment
        )
    await session.flush()
    return True


async def _enqueue_avatar_deletion_async(
    session: AsyncSession,
    *,
    settings: Settings,
    object_key: str,
    now: datetime,
    file_object_id: int | None = None,
) -> None:
    existing = await session.scalar(
        select(FileObjectDeletion.id).where(
            FileObjectDeletion.storage_location == FileStorageLocation.AVATAR_PUBLIC,
            FileObjectDeletion.object_key == object_key,
        )
    )
    if existing is None:
        session.add(
            FileObjectDeletion(
                file_object_id=file_object_id,
                storage_location=FileStorageLocation.AVATAR_PUBLIC,
                object_key=object_key,
                purge_url=_purge_url(settings, object_key),
                available_at=now,
            )
        )


async def _enqueue_avatar_manifest_deletions_async(
    session: AsyncSession,
    *,
    upload: FileUpload,
    settings: Settings,
    now: datetime,
) -> None:
    for entry in upload.output_manifest or []:
        if entry.get("role") != FileObjectRole.AVATAR_512.value:
            continue
        object_key = str(entry.get("object_key") or "")
        if object_key:
            await _enqueue_avatar_deletion_async(
                session, settings=settings, object_key=object_key, now=now
            )


async def _begin_avatar_asset_deletion_async(
    session: AsyncSession,
    *,
    file: FileAsset,
    settings: Settings,
    now: datetime,
) -> None:
    if file.deletion_started_at is not None:
        return
    file.deletion_started_at = now
    objects = list(
        (await session.scalars(select(FileObject).where(FileObject.file_id == file.id))).all()
    )
    for object_row in objects:
        await _enqueue_avatar_deletion_async(
            session,
            settings=settings,
            object_key=object_row.object_key,
            now=now,
            file_object_id=object_row.id,
        )
