from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, exists, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.avatar import AvatarDeletion, AvatarUpload, AvatarUploadStatus
from app.services.avatars.storage import AvatarStorage, CdnPurger


def sweep_uploads(
    session: Session, *, settings: Settings, now: datetime | None = None
) -> list[str]:
    moment = now or datetime.now(UTC)
    batch = settings.avatar_maintenance_batch_size

    expired_processing = list(
        session.scalars(
            select(AvatarUpload)
            .where(
                AvatarUpload.status == AvatarUploadStatus.PROCESSING,
                AvatarUpload.lease_expires_at <= moment,
            )
            .order_by(AvatarUpload.lease_expires_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    for upload in expired_processing:
        upload.lease_owner = None
        upload.lease_expires_at = None
        if upload.attempt_count >= settings.avatar_processing_max_attempts:
            upload.status = AvatarUploadStatus.FAILED
            upload.error_code = "processing_failed"
            upload.completed_at = moment
        else:
            upload.status = AvatarUploadStatus.QUEUED
            upload.queued_at = moment

    expired_pending = list(
        session.scalars(
            select(AvatarUpload)
            .where(
                AvatarUpload.status == AvatarUploadStatus.PENDING,
                AvatarUpload.expires_at <= moment,
            )
            .order_by(AvatarUpload.expires_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    for upload in expired_pending:
        upload.status = AvatarUploadStatus.EXPIRED
        upload.error_code = "upload_expired"
        upload.completed_at = moment

    due = list(
        session.scalars(
            select(AvatarUpload.upload_id)
            .where(
                AvatarUpload.status == AvatarUploadStatus.QUEUED,
                AvatarUpload.queued_at <= moment,
                AvatarUpload.is_current.is_(True),
            )
            .order_by(AvatarUpload.queued_at)
            .limit(batch)
        )
    )
    session.flush()
    return due


def cleanup_temporary_objects(
    session: Session,
    *,
    settings: Settings,
    storage: AvatarStorage,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    threshold = moment - timedelta(seconds=settings.avatar_cleanup_safety_seconds)
    uploads = list(
        session.scalars(
            select(AvatarUpload)
            .where(
                AvatarUpload.temporary_deleted_at.is_(None),
                AvatarUpload.completed_at.is_not(None),
                AvatarUpload.completed_at <= threshold,
                AvatarUpload.status.in_(
                    [
                        AvatarUploadStatus.SUCCEEDED,
                        AvatarUploadStatus.FAILED,
                        AvatarUploadStatus.EXPIRED,
                    ]
                ),
            )
            .order_by(AvatarUpload.completed_at)
            .limit(settings.avatar_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    cleaned = 0
    for upload in uploads:
        try:
            storage.delete_temporary(upload.temporary_object_key)
        except Exception:
            continue
        upload.temporary_deleted_at = moment
        cleaned += 1
    session.flush()
    return cleaned


def process_deletions(
    session: Session,
    *,
    settings: Settings,
    storage: AvatarStorage,
    purger: CdnPurger,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    rows = list(
        session.scalars(
            select(AvatarDeletion)
            .where(
                AvatarDeletion.completed_at.is_(None),
                AvatarDeletion.next_attempt_at <= moment,
            )
            .order_by(AvatarDeletion.next_attempt_at)
            .limit(settings.avatar_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    completed = 0
    for row in rows:
        row.attempt_count += 1
        errors: list[str] = []
        if row.object_deleted_at is None:
            try:
                storage.delete_public(row.object_key)
                row.object_deleted_at = moment
            except Exception as exc:  # noqa: BLE001 - persisted for compensation retry
                errors.append(f"object delete: {type(exc).__name__}")
        if row.cdn_purged_at is None:
            try:
                purger.purge(row.purge_url)
                row.cdn_purged_at = moment
            except Exception as exc:  # noqa: BLE001 - persisted for compensation retry
                errors.append(f"cdn purge: {type(exc).__name__}")
        if row.object_deleted_at is not None and row.cdn_purged_at is not None:
            row.completed_at = moment
            row.last_error = None
            completed += 1
        else:
            row.last_error = "; ".join(errors)
            delay = min(6 * 3600, 60 * (2 ** min(row.attempt_count - 1, 8)))
            row.next_attempt_at = moment + timedelta(seconds=delay)
    session.flush()
    return completed


def purge_upload_history(
    session: Session, *, settings: Settings, now: datetime | None = None
) -> int:
    moment = now or datetime.now(UTC)
    threshold = moment - timedelta(seconds=settings.avatar_history_retention_seconds)
    statement = delete(AvatarUpload).where(
        AvatarUpload.completed_at <= threshold,
        AvatarUpload.temporary_deleted_at.is_not(None),
        ~exists().where(
            AvatarDeletion.upload_id == AvatarUpload.id,
            AvatarDeletion.completed_at.is_(None),
        ),
    )
    result = session.execute(statement)
    return int(getattr(result, "rowcount", 0) or 0)
