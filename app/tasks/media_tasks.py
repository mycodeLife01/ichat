from typing import cast
from uuid import uuid4

from loguru import logger

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.models.files import FileStorageLocation
from app.services.avatars.maintenance import (
    cleanup_temporary_objects,
    purge_upload_history,
)
from app.services.avatars.maintenance import (
    process_deletions as process_legacy_deletions,
)
from app.services.avatars.maintenance import (
    sweep_uploads as sweep_legacy_uploads,
)
from app.services.avatars.processing import process_upload as process_legacy_upload
from app.services.avatars.storage import CloudflareCdnPurger, R2AvatarStorage
from app.services.files.avatar import (
    cleanup_avatar_staging_objects,
    sweep_avatar_uploads,
)
from app.services.files.avatar import (
    process_avatar_upload as process_unified_avatar_upload,
)
from app.services.files.maintenance import process_deletions as process_file_deletions
from app.services.files.protocols import FileStorage
from app.tasks.celery_app import celery_app


@celery_app.task(name="app.tasks.media_tasks.process_avatar_upload")  # type: ignore[untyped-decorator]
def process_avatar_upload(upload_id: str) -> str:
    settings = get_settings()
    if not settings.avatar_storage_enabled:
        return "disabled"
    storage = R2AvatarStorage(settings, worker=True)
    result = process_unified_avatar_upload(
        get_sync_session_factory(),
        upload_id=upload_id,
        settings=settings,
        storage=storage,
        task_id=uuid4().hex,
    )
    # Expand-contract bridge: old task facts remain executable until their
    # queue/history retention has drained. New API writes never create them.
    if result == "missing":
        result = process_legacy_upload(
            get_sync_session_factory(),
            upload_id=upload_id,
            settings=settings,
            storage=storage,
            task_id=uuid4().hex,
        )
    logger.info(
        "process_avatar_upload upload_id={upload_id} result={result}",
        upload_id=upload_id,
        result=result,
    )
    if result == "retry":
        process_avatar_upload.apply_async(args=[upload_id], countdown=30, queue="media")
    return result


@celery_app.task(name="app.tasks.media_tasks.maintain_avatars")  # type: ignore[untyped-decorator]
def maintain_avatars() -> dict[str, int]:
    settings = get_settings()
    if not settings.avatar_storage_enabled:
        return {
            "requeued": 0,
            "temporary_cleaned": 0,
            "deletions_completed": 0,
            "history_purged": 0,
        }
    storage = R2AvatarStorage(settings, worker=True)
    purger = CloudflareCdnPurger(settings)
    factory = get_sync_session_factory()
    with factory() as session:
        legacy_due = sweep_legacy_uploads(session, settings=settings)
        unified_due = sweep_avatar_uploads(session, settings=settings)
        legacy_temporary_cleaned = cleanup_temporary_objects(
            session, settings=settings, storage=storage
        )
        unified_temporary_cleaned = cleanup_avatar_staging_objects(
            session, settings=settings, storage=storage
        )
        legacy_deletions_completed = process_legacy_deletions(
            session, settings=settings, storage=storage, purger=purger
        )
        unified_deletions_completed = process_file_deletions(
            session,
            settings=settings,
            private_storage=cast(FileStorage, storage),
            delete_public=storage.delete_public,
            purge_cdn=purger.purge,
            storage_locations={FileStorageLocation.AVATAR_PUBLIC},
        )
        history_purged = purge_upload_history(session, settings=settings)
        session.commit()
    for upload_id in [*legacy_due, *unified_due]:
        process_avatar_upload.apply_async(args=[upload_id], queue="media")
    result = {
        "requeued": len(legacy_due) + len(unified_due),
        "temporary_cleaned": legacy_temporary_cleaned + unified_temporary_cleaned,
        "deletions_completed": legacy_deletions_completed + unified_deletions_completed,
        "history_purged": history_purged,
    }
    logger.info("maintain_avatars result={result}", result=result)
    return result
