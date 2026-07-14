from uuid import uuid4

from loguru import logger

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.services.avatars.maintenance import (
    cleanup_temporary_objects,
    process_deletions,
    purge_upload_history,
    sweep_uploads,
)
from app.services.avatars.processing import process_upload
from app.services.avatars.storage import CloudflareCdnPurger, R2AvatarStorage
from app.tasks.celery_app import celery_app


@celery_app.task(name="app.tasks.media_tasks.process_avatar_upload")  # type: ignore[untyped-decorator]
def process_avatar_upload(upload_id: str) -> str:
    settings = get_settings()
    if not settings.avatar_storage_enabled:
        return "disabled"
    result = process_upload(
        get_sync_session_factory(),
        upload_id=upload_id,
        settings=settings,
        storage=R2AvatarStorage(settings, worker=True),
        task_id=uuid4().hex,
    )
    logger.info(
        "process_avatar_upload upload_id={upload_id} result={result}",
        upload_id=upload_id,
        result=result,
    )
    if result == "retry":
        process_avatar_upload.apply_async(args=[upload_id], countdown=5, queue="media")
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
        due = sweep_uploads(session, settings=settings)
        temporary_cleaned = cleanup_temporary_objects(session, settings=settings, storage=storage)
        deletions_completed = process_deletions(
            session, settings=settings, storage=storage, purger=purger
        )
        history_purged = purge_upload_history(session, settings=settings)
        session.commit()
    for upload_id in due:
        process_avatar_upload.apply_async(args=[upload_id], queue="media")
    result = {
        "requeued": len(due),
        "temporary_cleaned": temporary_cleaned,
        "deletions_completed": deletions_completed,
        "history_purged": history_purged,
    }
    logger.info("maintain_avatars result={result}", result=result)
    return result
