from uuid import UUID, uuid4

from loguru import logger
from sqlalchemy import select

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.models.files import FileStorageLocation, FileUpload
from app.services.files.dependencies import get_file_worker_storage
from app.services.files.maintenance import (
    cleanup_staging_objects,
    file_maintenance_snapshot,
    process_deletions,
    purge_deleted_conversations,
    quota_reconciliation_user_ids,
    reclaim_assets,
    reconcile_quota,
    sweep_uploads,
)
from app.services.files.parsers import RestrictedFileParser
from app.services.files.processing import process_upload
from app.services.files.scanner import ClamAvScanner
from app.services.files.telemetry import emit_file_measure
from app.tasks.celery_app import celery_app

_FILE_ATTEMPT_TIME_LIMIT = max(2, get_settings().files_attempt_timeout_seconds)
_FILE_ATTEMPT_SOFT_TIME_LIMIT = max(1, _FILE_ATTEMPT_TIME_LIMIT - 5)


def _worker_configured() -> bool:
    settings = get_settings()
    return all(
        (
            settings.files_r2_endpoint_url,
            settings.files_staging_bucket,
            settings.files_canonical_bucket,
            settings.files_worker_access_key_id,
            settings.files_worker_secret_access_key,
            settings.clamav_host,
        )
    )


@celery_app.task(  # type: ignore[untyped-decorator]
    name="app.tasks.file_tasks.process_file_upload",
    soft_time_limit=_FILE_ATTEMPT_SOFT_TIME_LIMIT,
    time_limit=_FILE_ATTEMPT_TIME_LIMIT,
)
def process_file_upload(upload_id: str) -> str:
    # A disabled feature flag stops only new sessions. Existing PG facts keep
    # draining during rollback as long as worker credentials remain present.
    if not _worker_configured():
        return "unconfigured"
    settings = get_settings()
    scanner = ClamAvScanner(
        host=settings.clamav_host,
        port=settings.clamav_port,
        timeout_seconds=settings.clamav_timeout_seconds,
        signature_max_age_seconds=settings.clamav_signature_max_age_seconds,
    )
    result = process_upload(
        get_sync_session_factory(),
        upload_id=upload_id,
        settings=settings,
        storage=get_file_worker_storage(),
        scanner=scanner,
        parser=RestrictedFileParser(timeout_seconds=settings.files_parser_timeout_seconds),
        task_id=uuid4().hex,
    )
    if scanner.signature_age_seconds is not None:
        emit_file_measure(
            "files_clamav_signature_age_seconds",
            scanner.signature_age_seconds,
            upload_id=upload_id,
        )
    logger.bind(upload_id=upload_id, result=result).info("File upload processing finished")
    if result == "retry":
        countdown = 30
        try:
            with get_sync_session_factory()() as session:
                row = session.scalar(
                    select(FileUpload).where(FileUpload.public_id == UUID(upload_id))
                )
                if row is not None and row.attempt_count >= 2:
                    countdown = 300
        except Exception:
            # PG available_at is authoritative; a missing wakeup only delays to
            # the next maintenance sweep.
            return result
        process_file_upload.apply_async(args=[upload_id], countdown=countdown, queue="files")
    return result


@celery_app.task(name="app.tasks.file_tasks.maintain_files")  # type: ignore[untyped-decorator]
def maintain_files() -> dict[str, int]:
    if not _worker_configured():
        return {
            "requeued": 0,
            "staging_cleaned": 0,
            "assets_reclaimed": 0,
            "conversations_purged": 0,
            "deletions_completed": 0,
            "quota_rows_reconciled": 0,
        }
    settings = get_settings()
    storage = get_file_worker_storage()
    factory = get_sync_session_factory()
    with factory() as session:
        due = sweep_uploads(session, settings=settings)
        staging_cleaned = cleanup_staging_objects(
            session,
            settings=settings,
            storage=storage,
        )
        assets_reclaimed = reclaim_assets(session, settings=settings)
        conversations_purged = purge_deleted_conversations(session, settings=settings)
        deletions_completed = process_deletions(
            session,
            settings=settings,
            private_storage=storage,
            storage_locations={FileStorageLocation.CANONICAL_PRIVATE},
        )
        quota_user_ids = quota_reconciliation_user_ids(
            session,
            limit=settings.files_maintenance_batch_size,
        )
        drift_count = 0
        for user_id in quota_user_ids:
            used_drift, reserved_drift = reconcile_quota(session, user_id=user_id)
            if (used_drift, reserved_drift) != (0, 0):
                drift_count += 1
                emit_file_measure(
                    "files_quota_drift_bytes",
                    abs(used_drift) + abs(reserved_drift),
                    user_id=user_id,
                )
        snapshot = file_maintenance_snapshot(session, settings=settings)
        session.commit()
    for upload_id in due:
        try:
            process_file_upload.apply_async(args=[upload_id], queue="files")
        except Exception:
            logger.bind(upload_id=upload_id).warning(
                "File upload redispatch failed; next sweep will retry"
            )
    result = {
        "requeued": len(due),
        "staging_cleaned": staging_cleaned,
        "assets_reclaimed": assets_reclaimed,
        "conversations_purged": conversations_purged,
        "deletions_completed": deletions_completed,
        "quota_rows_reconciled": drift_count,
    }
    logger.bind(**result).info("File maintenance finished")
    for metric_name, value in snapshot.items():
        emit_file_measure(f"files_{metric_name}", value)
    return result
