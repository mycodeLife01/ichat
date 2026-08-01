"""Account-deactivation cleanup owned by the unified files domain."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.avatar import AvatarUpload, AvatarUploadStatus
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FilePurpose,
    FileQuota,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
)
from app.models.user import User
from app.services.avatars.storage import public_avatar_url
from app.services.files.lifecycle import transition_upload


async def deactivate_user_files(
    session: AsyncSession,
    *,
    user: User,
    settings: Settings,
    now: datetime | None = None,
) -> None:
    """Cancel in-flight uploads and remove only the account's public avatar.

    Bound message attachments intentionally remain attached to the soft-deleted
    account's retained conversations. Pending/queued/processing attachment rows
    are terminalized, release their reservation, and preserve any durable
    manifest cleanup facts before the transaction commits.
    """

    moment = now or datetime.now(UTC)
    uploads = list(
        (
            await session.scalars(
                select(FileUpload)
                .where(
                    FileUpload.user_id == user.id,
                    FileUpload.status.in_(
                        [
                            FileUploadStatus.PENDING,
                            FileUploadStatus.QUEUED,
                            FileUploadStatus.PROCESSING,
                        ]
                    ),
                )
                .with_for_update()
            )
        ).all()
    )
    released_attachment_bytes = 0
    for upload in uploads:
        transition_upload(
            upload,
            FileUploadStatus.CANCELLED,
            now=moment,
            error_code="account_inactive",
        )
        if upload.purpose == FilePurpose.MESSAGE_ATTACHMENT:
            released_attachment_bytes += upload.declared_size_bytes
            await _enqueue_private_manifest_deletions(
                session,
                upload=upload,
                now=moment,
            )
        elif upload.purpose == FilePurpose.AVATAR:
            await _enqueue_avatar_manifest_deletions(
                session,
                upload=upload,
                settings=settings,
                now=moment,
            )
    if released_attachment_bytes:
        quota = await _locked_quota(session, user_id=user.id)
        quota.reserved_bytes = max(0, quota.reserved_bytes - released_attachment_bytes)

    # Legacy avatar rows may still be in-flight during the expand phase. They
    # never receive new writes, but must not publish after account deactivation.
    await session.execute(
        update(AvatarUpload)
        .where(
            AvatarUpload.user_id == user.id,
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
            error_code="account_inactive",
            completed_at=moment,
            lease_owner=None,
            lease_expires_at=None,
        )
    )

    avatar_file = None
    if user.avatar_file_id is not None:
        avatar_file = await session.scalar(
            select(FileAsset).where(FileAsset.id == user.avatar_file_id).with_for_update()
        )
    fallback_key = user.avatar_object_key
    user.avatar_file_id = None
    user.avatar_object_key = None
    if avatar_file is not None:
        await _begin_avatar_asset_deletion(
            session,
            file=avatar_file,
            settings=settings,
            now=moment,
        )
    elif fallback_key is not None:
        await _enqueue_avatar_deletion(
            session,
            settings=settings,
            object_key=fallback_key,
            now=moment,
        )
    await session.flush()


async def _locked_quota(session: AsyncSession, *, user_id: int) -> FileQuota:
    await session.execute(
        insert(FileQuota)
        .values(user_id=user_id)
        .on_conflict_do_nothing(index_elements=[FileQuota.user_id])
    )
    quota = await session.scalar(
        select(FileQuota).where(FileQuota.user_id == user_id).with_for_update()
    )
    if quota is None:
        raise RuntimeError("File quota row is unavailable")
    return quota


async def _enqueue_private_manifest_deletions(
    session: AsyncSession,
    *,
    upload: FileUpload,
    now: datetime,
) -> None:
    for entry in upload.output_manifest or []:
        object_key = str(entry.get("object_key") or "")
        if not object_key:
            continue
        existing = await session.scalar(
            select(FileObjectDeletion.id).where(
                FileObjectDeletion.storage_location == FileStorageLocation.CANONICAL_PRIVATE,
                FileObjectDeletion.object_key == object_key,
            )
        )
        if existing is None:
            session.add(
                FileObjectDeletion(
                    storage_location=FileStorageLocation.CANONICAL_PRIVATE,
                    object_key=object_key,
                    available_at=now,
                )
            )


async def _enqueue_avatar_manifest_deletions(
    session: AsyncSession,
    *,
    upload: FileUpload,
    settings: Settings,
    now: datetime,
) -> None:
    for entry in upload.output_manifest or []:
        if entry.get("role") != "avatar_512":
            continue
        object_key = str(entry.get("object_key") or "")
        if object_key:
            await _enqueue_avatar_deletion(
                session,
                settings=settings,
                object_key=object_key,
                now=now,
            )


async def _enqueue_avatar_deletion(
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
    if existing is not None:
        return
    purge_url = public_avatar_url(settings, object_key)
    if purge_url is None:
        raise RuntimeError("Avatar public base URL is required")
    session.add(
        FileObjectDeletion(
            file_object_id=file_object_id,
            storage_location=FileStorageLocation.AVATAR_PUBLIC,
            object_key=object_key,
            purge_url=purge_url,
            available_at=now,
        )
    )


async def _begin_avatar_asset_deletion(
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
        await _enqueue_avatar_deletion(
            session,
            settings=settings,
            object_key=object_row.object_key,
            now=now,
            file_object_id=object_row.id,
        )
