"""Celery tasks for finite, retryable LLM work."""

import json
from dataclasses import dataclass
from typing import Literal, NoReturn

from celery.app.task import Task
from loguru import logger
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.sync_session import get_sync_session_factory
from app.models.conversation import Conversation, Message
from app.models.files import MessageAttachment
from app.models.run import Run
from app.services.agents import build_title_agent
from app.services.conversations.title_jobs import (
    claim_title_job,
    complete_title_job,
    fail_title_job,
    list_due_title_jobs,
)
from app.tasks.celery_app import celery_app

_TITLE_MAX_RETRIES = 3
_TITLE_MAX_ATTEMPTS = _TITLE_MAX_RETRIES + 1
_TITLE_RETRY_BASE_SECONDS = 5
_TITLE_RETRY_MAX_SECONDS = 60
_TITLE_JOB_LEASE_SECONDS = 120


@dataclass(frozen=True)
class TitleInputs:
    conversation_id: int
    user_content: str
    assistant_content: str
    attachment_metadata: str | None = None


@celery_app.task(  # type: ignore[untyped-decorator]
    bind=True,
    name="app.tasks.llm_tasks.generate_conversation_title",
    max_retries=_TITLE_MAX_RETRIES,
)
def generate_conversation_title(
    task: Task,
    run_id: int,
) -> Literal["disabled", "skipped", "updated"]:
    settings = get_settings()
    if not settings.auto_title_enabled:
        return "disabled"

    factory = get_sync_session_factory()
    with factory() as session:
        claim = claim_title_job(
            session,
            run_id=run_id,
            lease_seconds=_TITLE_JOB_LEASE_SECONDS,
        )
        session.commit()
    if claim is None:
        return "skipped"

    try:
        with factory() as session:
            inputs = _load_title_inputs(session, run_id=run_id)
        if inputs is None:
            with factory() as session:
                complete_title_job(session, run_id=run_id)
                session.commit()
            return "skipped"

        title = build_title_agent(settings=settings).generate(
            user_content=inputs.user_content,
            assistant_content=inputs.assistant_content,
            attachment_metadata=inputs.attachment_metadata,
        )
        with factory() as session:
            updated_id = None
            if title is not None:
                updated_id = session.scalar(
                    update(Conversation)
                    .where(
                        Conversation.id == inputs.conversation_id,
                        Conversation.title.is_(None),
                    )
                    .values(title=title, updated_at=func.now())
                    .returning(Conversation.id)
                )
            complete_title_job(session, run_id=run_id)
            session.commit()
        return "updated" if updated_id is not None else "skipped"
    except Exception as exc:
        _retry_title_task(
            task,
            run_id=run_id,
            attempt_count=claim.attempt_count,
            exc=exc,
        )


@celery_app.task(name="app.tasks.llm_tasks.sweep_conversation_title_jobs")  # type: ignore[untyped-decorator]
def sweep_conversation_title_jobs() -> int:
    factory = get_sync_session_factory()
    with factory() as session:
        run_ids = list_due_title_jobs(session)
        session.commit()
    for run_id in run_ids:
        try:
            generate_conversation_title.apply_async(args=[run_id])
        except Exception as exc:
            logger.bind(run_id=run_id, error=str(exc)).warning(
                "Conversation title job redispatch failed; next sweep will retry"
            )
    return len(run_ids)


def _load_title_inputs(session: Session, *, run_id: int) -> TitleInputs | None:
    run = session.get(Run, run_id)
    if run is None or run.status != "succeeded":
        return None

    conversation = session.get(Conversation, run.conversation_id)
    if (
        conversation is None
        or conversation.deleted_at is not None
        or conversation.title is not None
    ):
        return None

    first_succeeded_run_id = session.scalar(
        select(Run.id)
        .where(
            Run.conversation_id == run.conversation_id,
            Run.status == "succeeded",
        )
        .order_by(Run.completed_at.asc().nulls_last(), Run.created_at.asc(), Run.id.asc())
        .limit(1)
    )
    if first_succeeded_run_id != run.id:
        return None

    first_user = session.get(Message, run.user_message_id)
    assistant = session.scalar(
        select(Message)
        .where(
            Message.run_id == run_id,
            Message.role == "assistant",
        )
        .order_by(Message.position.asc())
        .limit(1)
    )
    if (
        first_user is None
        or first_user.role != "user"
        or assistant is None
        or not assistant.content.strip()
    ):
        return None

    return TitleInputs(
        conversation_id=run.conversation_id,
        user_content=first_user.content,
        assistant_content=assistant.content,
        attachment_metadata=_title_attachment_metadata(session, message_id=first_user.id),
    )


def _title_attachment_metadata(session: Session, *, message_id: int) -> str | None:
    rows = list(
        session.scalars(
            select(MessageAttachment)
            .where(MessageAttachment.message_id == message_id)
            .order_by(MessageAttachment.position)
        )
    )
    if not rows:
        return None
    return json.dumps(
        [
            {
                "name": row.name,
                "media_type": row.media_type,
                "size_bytes": row.size_bytes,
            }
            for row in rows
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _retry_title_task(
    task: Task,
    *,
    run_id: int,
    attempt_count: int,
    exc: Exception,
) -> NoReturn:
    dead = attempt_count >= _TITLE_MAX_ATTEMPTS
    countdown = min(
        _TITLE_RETRY_MAX_SECONDS,
        _TITLE_RETRY_BASE_SECONDS * (2 ** max(attempt_count - 1, 0)),
    )
    factory = get_sync_session_factory()
    with factory() as session:
        fail_title_job(
            session,
            run_id=run_id,
            error=str(exc),
            retry_after_seconds=countdown,
            dead=dead,
        )
        session.commit()

    if dead:
        logger.bind(run_id=run_id, error=str(exc)).error(
            "Conversation title generation exhausted retries; title remains unset"
        )
        raise exc

    logger.bind(
        run_id=run_id,
        attempt=attempt_count,
        max_attempts=_TITLE_MAX_ATTEMPTS,
        countdown=countdown,
        error=str(exc),
    ).warning("Conversation title generation failed; retrying")
    raise task.retry(exc=exc, countdown=countdown, max_retries=_TITLE_MAX_RETRIES)
