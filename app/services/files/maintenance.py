from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.conversation import Conversation, Message
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FilePurpose,
    FileQuota,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
    MessageAttachment,
)
from app.models.run import Run
from app.services.files.lifecycle import retry_available_at, transition_upload
from app.services.files.protocols import FileStorage
from app.services.files.telemetry import observe_file_phase


def _locked_quota(session: Session, *, user_id: int) -> FileQuota:
    quota = session.scalar(select(FileQuota).where(FileQuota.user_id == user_id).with_for_update())
    if quota is None:
        quota = FileQuota(user_id=user_id)
        session.add(quota)
        session.flush()
    return quota


def _release_reserved(session: Session, upload: FileUpload) -> None:
    if upload.purpose != FilePurpose.MESSAGE_ATTACHMENT:
        return
    quota = _locked_quota(session, user_id=upload.user_id)
    quota.reserved_bytes = max(0, quota.reserved_bytes - upload.declared_size_bytes)


def _enqueue_manifest_deletions(session: Session, upload: FileUpload, now: datetime) -> None:
    for entry in upload.output_manifest or []:
        key = str(entry.get("object_key") or "")
        if not key:
            continue
        exists = session.scalar(
            select(FileObjectDeletion.id).where(
                FileObjectDeletion.storage_location
                == FileStorageLocation.CANONICAL_PRIVATE,
                FileObjectDeletion.object_key == key,
            )
        )
        if exists is None:
            session.add(
                FileObjectDeletion(
                    storage_location=FileStorageLocation.CANONICAL_PRIVATE,
                    object_key=key,
                    available_at=now,
                )
            )


def sweep_uploads(
    session: Session,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> list[str]:
    moment = now or datetime.now(UTC)
    batch = settings.files_maintenance_batch_size

    processing = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileUpload.status == FileUploadStatus.PROCESSING,
                FileUpload.lease_expires_at <= moment,
            )
            .order_by(FileUpload.lease_expires_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    for upload in processing:
        if upload.attempt_count >= settings.files_processing_max_attempts:
            transition_upload(
                upload,
                FileUploadStatus.FAILED,
                now=moment,
                error_code="processing_failed",
            )
            _release_reserved(session, upload)
            _enqueue_manifest_deletions(session, upload, moment)
        else:
            transition_upload(upload, FileUploadStatus.QUEUED, now=moment)
            upload.available_at = retry_available_at(
                attempt_count=upload.attempt_count,
                now=moment,
            )

    pending = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
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
        _release_reserved(session, upload)

    # A cancelled/rejected/failed task can have written canonical output before
    # losing the final row-lock race. The manifest is sufficient for cleanup.
    dirty_terminal = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
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
        _enqueue_manifest_deletions(session, upload, moment)
        # Once every manifest entry has a durable deletion fact, clearing the
        # manifest is the progress marker that lets the bounded sweep advance.
        upload.output_manifest = None

    due = list(
        session.scalars(
            select(FileUpload.public_id)
            .where(
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileUpload.status == FileUploadStatus.QUEUED,
                FileUpload.available_at <= moment,
            )
            .order_by(FileUpload.available_at)
            .limit(batch)
        )
    )
    session.flush()
    return [str(upload_id) for upload_id in due]


def cleanup_staging_objects(
    session: Session,
    *,
    settings: Settings,
    storage: FileStorage,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    threshold = moment - timedelta(seconds=settings.files_cleanup_safety_seconds)
    uploads = list(
        session.scalars(
            select(FileUpload)
            .where(
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
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
            .limit(settings.files_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    count = 0
    for upload in uploads:
        try:
            with observe_file_phase(
                "staging_cleanup",
                upload_id=str(upload.public_id),
            ):
                storage.delete_staging(upload.staging_object_key)
        except Exception:
            continue
        upload.staging_deleted_at = moment
        count += 1
    session.flush()
    return count


def _begin_asset_deletion(session: Session, file: FileAsset, now: datetime) -> None:
    if file.deletion_started_at is not None:
        return
    file.deletion_started_at = now
    for object_row in session.scalars(
        select(FileObject).where(FileObject.file_id == file.id)
    ):
        existing = session.scalar(
            select(FileObjectDeletion.id).where(
                FileObjectDeletion.storage_location == object_row.storage_location,
                FileObjectDeletion.object_key == object_row.object_key,
            )
        )
        if existing is None:
            session.add(
                FileObjectDeletion(
                    file_object_id=object_row.id,
                    storage_location=object_row.storage_location,
                    object_key=object_row.object_key,
                    available_at=now,
                )
            )
    if file.purpose == FilePurpose.MESSAGE_ATTACHMENT:
        quota = _locked_quota(session, user_id=file.user_id)
        quota.used_bytes = max(0, quota.used_bytes - file.size_bytes)


def reclaim_assets(
    session: Session,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    detached_before = moment - timedelta(seconds=settings.files_detached_retention_seconds)
    assets = list(
        session.scalars(
            select(FileAsset)
            .where(
                FileAsset.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileAsset.deletion_started_at.is_(None),
                (
                    (
                        FileAsset.bound_at.is_(None)
                        & (FileAsset.unbound_expires_at <= moment)
                    )
                    | (
                        FileAsset.detached_at.is_not(None)
                        & (FileAsset.detached_at <= detached_before)
                    )
                ),
            )
            .order_by(FileAsset.unbound_expires_at, FileAsset.detached_at)
            .limit(settings.files_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    for file in assets:
        _begin_asset_deletion(session, file, moment)
    session.flush()
    return len(assets)


def purge_deleted_conversations(
    session: Session,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    conversations = list(
        session.scalars(
            select(Conversation)
            .where(
                Conversation.deleted_at.is_not(None),
                Conversation.deletion_due_at <= moment,
            )
            .order_by(Conversation.deletion_due_at)
            .limit(settings.files_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    for conversation in conversations:
        file_ids = list(
            session.scalars(
                select(MessageAttachment.file_id)
                .join(Message, Message.id == MessageAttachment.message_id)
                .where(
                    Message.conversation_id == conversation.id,
                    MessageAttachment.file_id.is_not(None),
                )
                .distinct()
            )
        )
        session.execute(delete(Run).where(Run.conversation_id == conversation.id))
        session.execute(delete(Message).where(Message.conversation_id == conversation.id))
        session.flush()
        for file_id in file_ids:
            if file_id is None:
                continue
            other_reference = session.scalar(
                select(MessageAttachment.id)
                .where(MessageAttachment.file_id == file_id)
                .limit(1)
            )
            if other_reference is None:
                file = session.get(FileAsset, file_id)
                if file is not None:
                    _begin_asset_deletion(session, file, moment)
        session.delete(conversation)
    session.flush()
    return len(conversations)


def reconcile_quota(
    session: Session,
    *,
    user_id: int,
) -> tuple[int, int]:
    # Every quota writer takes this row before changing admission facts. Lock
    # it before calculating the snapshot so a concurrent create/finalize cannot
    # be overwritten by an older aggregate.
    quota = _locked_quota(session, user_id=user_id)
    used = int(
        session.scalar(
            select(func.coalesce(func.sum(FileAsset.size_bytes), 0)).where(
                FileAsset.user_id == user_id,
                FileAsset.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileAsset.deletion_started_at.is_(None),
            )
        )
        or 0
    )
    reserved = int(
        session.scalar(
            select(func.coalesce(func.sum(FileUpload.declared_size_bytes), 0)).where(
                FileUpload.user_id == user_id,
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileUpload.status.in_(
                    [
                        FileUploadStatus.PENDING,
                        FileUploadStatus.QUEUED,
                        FileUploadStatus.PROCESSING,
                    ]
                ),
            )
        )
        or 0
    )
    drift = (used - quota.used_bytes, reserved - quota.reserved_bytes)
    quota.used_bytes = used
    quota.reserved_bytes = reserved
    quota.updated_at = datetime.now(UTC)
    session.flush()
    return drift


def quota_reconciliation_user_ids(session: Session, *, limit: int) -> list[int]:
    """Rotate reconciliation fairly through the oldest quota rows."""

    return list(
        session.scalars(
            select(FileQuota.user_id)
            .order_by(FileQuota.updated_at, FileQuota.user_id)
            .limit(limit)
        )
    )


def process_deletions(
    session: Session,
    *,
    settings: Settings,
    private_storage: FileStorage,
    delete_public: Callable[[str], None] | None = None,
    purge_cdn: Callable[[str], None] | None = None,
    storage_locations: set[FileStorageLocation] | None = None,
    now: datetime | None = None,
) -> int:
    moment = now or datetime.now(UTC)
    locations = storage_locations or {
        FileStorageLocation.CANONICAL_PRIVATE,
        FileStorageLocation.AVATAR_PUBLIC,
    }
    rows = list(
        session.scalars(
            select(FileObjectDeletion)
            .where(
                FileObjectDeletion.completed_at.is_(None),
                FileObjectDeletion.available_at <= moment,
                FileObjectDeletion.storage_location.in_(locations),
            )
            .order_by(FileObjectDeletion.available_at)
            .limit(settings.files_maintenance_batch_size)
            .with_for_update(skip_locked=True)
        )
    )
    completed = 0
    touched_file_ids: set[int] = set()
    for row in rows:
        row.attempt_count += 1
        errors: list[str] = []
        object_row = session.get(FileObject, row.file_object_id) if row.file_object_id else None
        if object_row is not None:
            touched_file_ids.add(object_row.file_id)
        if row.object_deleted_at is None:
            try:
                with observe_file_phase("object_delete", deletion_id=row.id):
                    if row.storage_location == FileStorageLocation.CANONICAL_PRIVATE:
                        private_storage.delete_canonical(row.object_key)
                    elif delete_public is None:
                        raise RuntimeError("public_delete_unavailable")
                    else:
                        delete_public(row.object_key)
                row.object_deleted_at = moment
            except Exception as exc:  # noqa: BLE001 - persisted compensation boundary
                errors.append(f"object_delete:{type(exc).__name__}")
        if row.storage_location == FileStorageLocation.AVATAR_PUBLIC:
            if row.cdn_purged_at is None:
                try:
                    with observe_file_phase("cdn_purge", deletion_id=row.id):
                        if purge_cdn is None or row.purge_url is None:
                            raise RuntimeError("cdn_purge_unavailable")
                        purge_cdn(row.purge_url)
                    row.cdn_purged_at = moment
                except Exception as exc:  # noqa: BLE001 - persisted compensation boundary
                    errors.append(f"cdn_purge:{type(exc).__name__}")
        else:
            row.cdn_purged_at = moment
        if row.object_deleted_at is not None and row.cdn_purged_at is not None:
            row.completed_at = moment
            row.error_summary = None
            completed += 1
            if object_row is not None:
                session.delete(object_row)
        else:
            row.error_summary = ";".join(errors)[:500]
            delay = min(6 * 3_600, 60 * (2 ** min(row.attempt_count - 1, 8)))
            row.available_at = moment + timedelta(seconds=delay)
    session.flush()
    for file_id in touched_file_ids:
        remaining = session.scalar(
            select(FileObject.id).where(FileObject.file_id == file_id).limit(1)
        )
        if remaining is None:
            file = session.get(FileAsset, file_id)
            if file is not None and file.deletion_started_at is not None:
                session.delete(file)
    session.flush()
    return completed


def file_maintenance_snapshot(
    session: Session,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> dict[str, int | float]:
    """Return bounded PG-derived operations metrics without exposing file data."""

    moment = now or datetime.now(UTC)
    values: dict[str, int | float] = {}
    for status_value, count in session.execute(
        select(FileUpload.status, func.count(FileUpload.id))
        .where(FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT)
        .group_by(FileUpload.status)
    ):
        status_name = (
            status_value.value
            if isinstance(status_value, FileUploadStatus)
            else str(status_value)
        )
        values[f"uploads_{status_name}"] = int(count)

    oldest_queued = session.scalar(
        select(func.min(FileUpload.queued_at)).where(
            FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
            FileUpload.status == FileUploadStatus.QUEUED,
        )
    )
    oldest_deletion = session.scalar(
        select(func.min(FileObjectDeletion.created_at)).where(
            FileObjectDeletion.completed_at.is_(None)
        )
    )
    values["oldest_queued_seconds"] = (
        max(0.0, (moment - oldest_queued).total_seconds())
        if oldest_queued is not None
        else 0.0
    )
    values["oldest_deletion_seconds"] = (
        max(0.0, (moment - oldest_deletion).total_seconds())
        if oldest_deletion is not None
        else 0.0
    )
    values["expired_processing"] = int(
        session.scalar(
            select(func.count(FileUpload.id)).where(
                FileUpload.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileUpload.status == FileUploadStatus.PROCESSING,
                FileUpload.lease_expires_at <= moment,
            )
        )
        or 0
    )
    values["due_deletions"] = int(
        session.scalar(
            select(func.count(FileObjectDeletion.id)).where(
                FileObjectDeletion.completed_at.is_(None),
                FileObjectDeletion.available_at <= moment,
            )
        )
        or 0
    )
    detached_before = moment - timedelta(seconds=settings.files_detached_retention_seconds)
    values["due_assets"] = int(
        session.scalar(
            select(func.count(FileAsset.id)).where(
                FileAsset.purpose == FilePurpose.MESSAGE_ATTACHMENT,
                FileAsset.deletion_started_at.is_(None),
                (
                    (
                        FileAsset.bound_at.is_(None)
                        & (FileAsset.unbound_expires_at <= moment)
                    )
                    | (
                        FileAsset.detached_at.is_not(None)
                        & (FileAsset.detached_at <= detached_before)
                    )
                ),
            )
        )
        or 0
    )
    values["due_conversations"] = int(
        session.scalar(
            select(func.count(Conversation.id)).where(
                Conversation.deleted_at.is_not(None),
                Conversation.deletion_due_at <= moment,
            )
        )
        or 0
    )
    return values
