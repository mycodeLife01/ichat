"""Celery tasks for email delivery.

Tasks carry only the outbox id; all content and state live in the
``email_outbox`` table. Both tasks are idempotent and safe to run from multiple
workers (claim is atomic; sweep recovers expired leases).
"""

from uuid import uuid4

from loguru import logger

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.services.email.outbox import process_outbox, sweep_outbox
from app.services.email.postmark import get_email_provider
from app.tasks.celery_app import celery_app


@celery_app.task(name="app.tasks.email_tasks.send_email_outbox")  # type: ignore[untyped-decorator]
def send_email_outbox(outbox_id: int) -> str:
    settings = get_settings()
    provider = get_email_provider(settings)
    factory = get_sync_session_factory()
    with factory() as session:
        try:
            result = process_outbox(
                session,
                outbox_id=outbox_id,
                settings=settings,
                provider=provider,
                task_id=uuid4().hex,
            )
            session.commit()
        except Exception:
            session.rollback()
            raise
    logger.info("send_email_outbox outbox_id={id} result={result}", id=outbox_id, result=result)
    return result


@celery_app.task(name="app.tasks.email_tasks.sweep_email_outbox")  # type: ignore[untyped-decorator]
def sweep_email_outbox() -> int:
    factory = get_sync_session_factory()
    with factory() as session:
        due = sweep_outbox(session)
        session.commit()
    for outbox_id in due:
        send_email_outbox.delay(outbox_id)
    if due:
        logger.info("sweep_email_outbox re-enqueued {count} outbox rows", count=len(due))
    return len(due)
