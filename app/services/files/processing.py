from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FileObjectRole,
    FilePurpose,
    FileQuota,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
)
from app.models.user import User
from app.services.files.formats import policy_for_filename
from app.services.files.lifecycle import retry_available_at, transition_upload
from app.services.files.protocols import (
    FileParser,
    FileProcessingError,
    FileStorage,
    MalwareScanner,
    ProcessedFile,
    ScanVerdict,
)
from app.services.files.telemetry import emit_file_phase, observe_file_phase


def process_upload(
    factory: sessionmaker[Session],
    *,
    upload_id: str,
    settings: Settings,
    storage: FileStorage,
    scanner: MalwareScanner,
    parser: FileParser,
    task_id: str | None = None,
    now: datetime | None = None,
) -> str:
    """Claim and process one message-attachment upload by public id.

    PostgreSQL owns claim/retry/terminal truth. The task id is only a lease
    owner, and the manifest is committed before the first canonical write.
    """

    moment = now or datetime.now(UTC)
    owner = task_id or uuid4().hex
    try:
        public_id = UUID(upload_id)
    except ValueError:
        return "missing"

    with factory() as session:
        upload_user_id = session.scalar(
            select(FileUpload.user_id).where(FileUpload.public_id == public_id)
        )
        if upload_user_id is None:
            return "missing"
        user = session.scalar(
            select(User).where(User.id == upload_user_id).with_for_update()
        )
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if upload is None:
            return "missing"
        if upload.status == FileUploadStatus.SUCCEEDED:
            return "succeeded"
        if (
            upload.user_id != upload_user_id
            or user is None
            or upload.purpose != FilePurpose.MESSAGE_ATTACHMENT
            or upload.status != FileUploadStatus.QUEUED
            or upload.available_at > moment
            or not user.is_active
            or upload.confirmed_etag is None
        ):
            return "not_claimable"
        transition_upload(upload, FileUploadStatus.PROCESSING, now=moment)
        upload.attempt_count += 1
        upload.lease_owner = owner
        upload.lease_expires_at = moment + timedelta(
            seconds=settings.files_processing_lease_seconds
        )
        staging_key = upload.staging_object_key
        etag = upload.confirmed_etag
        filename = upload.original_filename
        declared_size = upload.declared_size_bytes
        attempt_count = upload.attempt_count
        existing_manifest = list(upload.output_manifest or [])
        queue_wait_seconds = max(
            0.0,
            (moment - (upload.queued_at or upload.created_at)).total_seconds(),
        )
        session.commit()

    emit_file_phase(
        "queue_wait",
        outcome="succeeded",
        duration_seconds=queue_wait_seconds,
        upload_id=str(public_id),
    )

    try:
        with observe_file_phase("if_match_get", upload_id=str(public_id)):
            source = storage.get_staging(staging_key, if_match=etag)
            if len(source) != declared_size:
                raise FileProcessingError("object_changed")
        source_hash = sha256(source).hexdigest()
        with observe_file_phase("clamav", upload_id=str(public_id)):
            verdict = scanner.scan(source)
            if verdict == ScanVerdict.INFECTED:
                raise FileProcessingError("malware_detected")
        with observe_file_phase("parse", upload_id=str(public_id)):
            processed = parser.parse(source, policy_for_filename(filename))
            if processed.original.content != source:
                raise FileProcessingError("original_changed")
        manifest = existing_manifest or _build_manifest(processed)
        with observe_file_phase("manifest_commit", upload_id=str(public_id)):
            _persist_manifest(
                factory,
                public_id=public_id,
                owner=owner,
                manifest=manifest,
            )
        with observe_file_phase("r2_write", upload_id=str(public_id)):
            for derivative, entry in zip(processed.derivatives, manifest, strict=True):
                storage.put_canonical(
                    str(entry["object_key"]),
                    content=derivative.content,
                    content_type=derivative.content_type,
                )
    except FileProcessingError as exc:
        return _finish_error(
            factory,
            public_id=public_id,
            owner=owner,
            settings=settings,
            code=exc.code,
            retryable=exc.retryable,
            attempt_count=attempt_count,
            now=moment,
        )
    except Exception:
        return _finish_error(
            factory,
            public_id=public_id,
            owner=owner,
            settings=settings,
            code="processing_failed",
            retryable=True,
            attempt_count=attempt_count,
            now=moment,
        )

    with observe_file_phase("final_commit", upload_id=str(public_id)):
        result = _commit_success(
            factory,
            public_id=public_id,
            owner=owner,
            processed=processed,
            manifest=manifest,
            source_hash=source_hash,
            settings=settings,
            now=moment,
        )
    try:
        with observe_file_phase("staging_cleanup", upload_id=str(public_id)):
            storage.delete_staging(staging_key)
            with factory() as session:
                current = session.scalar(
                    select(FileUpload).where(FileUpload.public_id == public_id)
                )
                if current is not None:
                    current.staging_deleted_at = datetime.now(UTC)
                    session.commit()
    except Exception:
        return result
    return result


def _build_manifest(processed: ProcessedFile) -> list[dict[str, Any]]:
    return [
        {
            "role": derivative.role,
            "object_key": f"files/{uuid4().hex}/{derivative.role}",
            "media_type": derivative.content_type,
            "size_bytes": derivative.size_bytes,
            "sha256": derivative.sha256_hex,
        }
        for derivative in processed.derivatives
    ]


def _persist_manifest(
    factory: sessionmaker[Session],
    *,
    public_id: UUID,
    owner: str,
    manifest: list[dict[str, Any]],
) -> None:
    with factory() as session:
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if (
            upload is None
            or upload.status != FileUploadStatus.PROCESSING
            or upload.lease_owner != owner
        ):
            raise FileProcessingError("upload_cancelled")
        if upload.output_manifest is not None and upload.output_manifest != manifest:
            raise FileProcessingError("manifest_conflict")
        upload.output_manifest = manifest
        session.commit()


def _locked_quota(session: Session, *, user_id: int) -> FileQuota:
    quota = session.scalar(select(FileQuota).where(FileQuota.user_id == user_id).with_for_update())
    if quota is None:
        quota = FileQuota(user_id=user_id)
        session.add(quota)
        session.flush()
    return quota


def _release_reservation(session: Session, upload: FileUpload) -> None:
    if upload.purpose != FilePurpose.MESSAGE_ATTACHMENT:
        return
    quota = _locked_quota(session, user_id=upload.user_id)
    quota.reserved_bytes = max(0, quota.reserved_bytes - upload.declared_size_bytes)


def _finish_error(
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
        if retryable and attempt_count < settings.files_processing_max_attempts:
            transition_upload(upload, FileUploadStatus.QUEUED, now=now)
            upload.available_at = retry_available_at(attempt_count=attempt_count, now=now)
            upload.error_code = None
            session.commit()
            return "retry"
        target = FileUploadStatus.FAILED if retryable else FileUploadStatus.REJECTED
        transition_upload(upload, target, now=now, error_code=code)
        _release_reservation(session, upload)
        _enqueue_manifest_deletions(session, upload=upload, now=now)
        session.commit()
        return target.value


def _commit_success(
    factory: sessionmaker[Session],
    *,
    public_id: UUID,
    owner: str,
    processed: ProcessedFile,
    manifest: list[dict[str, Any]],
    source_hash: str,
    settings: Settings,
    now: datetime,
) -> str:
    with factory() as session:
        upload_user_id = session.scalar(
            select(FileUpload.user_id).where(FileUpload.public_id == public_id)
        )
        if upload_user_id is None:
            return "orphaned"
        user = session.scalar(
            select(User).where(User.id == upload_user_id).with_for_update()
        )
        upload = session.scalar(
            select(FileUpload).where(FileUpload.public_id == public_id).with_for_update()
        )
        if upload is None:
            return "orphaned"
        if (
            upload.user_id != upload_user_id
            or upload.status != FileUploadStatus.PROCESSING
            or upload.lease_owner != owner
            or user is None
            or not user.is_active
        ):
            _enqueue_manifest_deletions(session, upload=upload, now=now)
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
                _release_reservation(session, upload)
            session.commit()
            return "cancelled"

        extracted = processed.document_extract
        file = FileAsset(
            user_id=upload.user_id,
            purpose=upload.purpose,
            original_filename=upload.original_filename,
            media_type=processed.media_type,
            size_bytes=processed.original.size_bytes,
            sha256=source_hash,
            warnings=list(processed.warnings),
            extractor_version=processed.extractor_version,
            summary_metadata=dict(processed.metadata),
            model_consumable=processed.kind == "document",
            document_text=(
                extracted.content.decode("utf-8") if extracted is not None else None
            ),
            unbound_expires_at=now + timedelta(seconds=settings.files_unbound_ttl_seconds),
        )
        session.add(file)
        session.flush()
        for entry in manifest:
            session.add(
                FileObject(
                    file_id=file.id,
                    role=_object_role(str(entry["role"])),
                    storage_location=FileStorageLocation.CANONICAL_PRIVATE,
                    object_key=str(entry["object_key"]),
                    media_type=str(entry["media_type"]),
                    size_bytes=int(entry["size_bytes"]),
                    sha256=str(entry["sha256"]),
                )
            )
        quota = _locked_quota(session, user_id=upload.user_id)
        quota.reserved_bytes = max(0, quota.reserved_bytes - upload.declared_size_bytes)
        quota.used_bytes += processed.original.size_bytes
        upload.file_id = file.id
        transition_upload(upload, FileUploadStatus.SUCCEEDED, now=now)
        session.commit()
        return "succeeded"


def _object_role(role: str) -> FileObjectRole:
    return {
        "original": FileObjectRole.ORIGINAL,
        "preview": FileObjectRole.PREVIEW,
        "document_extract": FileObjectRole.DOCUMENT_EXTRACT,
    }[role]


def _enqueue_manifest_deletions(
    session: Session,
    *,
    upload: FileUpload,
    now: datetime,
) -> None:
    for entry in upload.output_manifest or []:
        key = str(entry.get("object_key") or "")
        if not key:
            continue
        existing = session.scalar(
            select(FileObjectDeletion.id).where(
                FileObjectDeletion.storage_location
                == FileStorageLocation.CANONICAL_PRIVATE,
                FileObjectDeletion.object_key == key,
            )
        )
        if existing is None:
            session.add(
                FileObjectDeletion(
                    storage_location=FileStorageLocation.CANONICAL_PRIVATE,
                    object_key=key,
                    available_at=now,
                )
            )
