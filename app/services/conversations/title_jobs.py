from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.conversation import Conversation
from app.models.run import ConversationTitleJob, Run


@dataclass(frozen=True)
class TitleJobClaim:
    run_id: int
    attempt_count: int


async def create_title_job(session: AsyncSession, *, run_id: int) -> bool:
    run = await session.get(Run, run_id)
    if run is None or run.status != "succeeded":
        return False
    conversation = await session.get(Conversation, run.conversation_id)
    if (
        conversation is None
        or conversation.deleted_at is not None
        or conversation.title is not None
    ):
        return False
    first_succeeded_run_id = await session.scalar(
        select(Run.id)
        .where(
            Run.conversation_id == run.conversation_id,
            Run.status == "succeeded",
        )
        .order_by(Run.completed_at.asc().nulls_last(), Run.created_at.asc(), Run.id.asc())
        .limit(1)
    )
    if first_succeeded_run_id != run.id:
        return False

    statement = (
        insert(ConversationTitleJob)
        .values(run_id=run.id, conversation_id=run.conversation_id, status="pending")
        .on_conflict_do_nothing(index_elements=[ConversationTitleJob.conversation_id])
        .returning(ConversationTitleJob.run_id)
    )
    return await session.scalar(statement) is not None


def claim_title_job(
    session: Session,
    *,
    run_id: int,
    lease_seconds: int,
    now: datetime | None = None,
) -> TitleJobClaim | None:
    moment = now or datetime.now(UTC)
    job = session.scalar(
        select(ConversationTitleJob)
        .where(
            ConversationTitleJob.run_id == run_id,
            or_(
                and_(
                    ConversationTitleJob.status == "pending",
                    ConversationTitleJob.next_attempt_at <= moment,
                ),
                and_(
                    ConversationTitleJob.status == "processing",
                    ConversationTitleJob.locked_until.is_not(None),
                    ConversationTitleJob.locked_until < moment,
                ),
            ),
        )
        .with_for_update(skip_locked=True)
    )
    if job is None:
        return None
    job.status = "processing"
    job.attempt_count += 1
    job.locked_until = moment + timedelta(seconds=lease_seconds)
    job.updated_at = moment
    session.flush()
    return TitleJobClaim(run_id=job.run_id, attempt_count=job.attempt_count)


def complete_title_job(
    session: Session,
    *,
    run_id: int,
    now: datetime | None = None,
) -> None:
    job = session.get(ConversationTitleJob, run_id)
    if job is None:
        return
    moment = now or datetime.now(UTC)
    job.status = "completed"
    job.locked_until = None
    job.last_error = None
    job.completed_at = moment
    job.updated_at = moment
    session.flush()


def fail_title_job(
    session: Session,
    *,
    run_id: int,
    error: str,
    retry_after_seconds: int,
    dead: bool,
    now: datetime | None = None,
) -> None:
    job = session.get(ConversationTitleJob, run_id)
    if job is None:
        return
    moment = now or datetime.now(UTC)
    job.status = "dead" if dead else "pending"
    job.locked_until = None
    job.last_error = error
    job.next_attempt_at = moment + timedelta(seconds=retry_after_seconds)
    job.updated_at = moment
    session.flush()


def list_due_title_jobs(
    session: Session,
    *,
    limit: int = 100,
    now: datetime | None = None,
) -> list[int]:
    moment = now or datetime.now(UTC)
    return list(
        session.scalars(
            select(ConversationTitleJob.run_id)
            .where(
                or_(
                    and_(
                        ConversationTitleJob.status == "pending",
                        ConversationTitleJob.next_attempt_at <= moment,
                    ),
                    and_(
                        ConversationTitleJob.status == "processing",
                        ConversationTitleJob.locked_until.is_not(None),
                        ConversationTitleJob.locked_until < moment,
                    ),
                )
            )
            .order_by(ConversationTitleJob.next_attempt_at.asc())
            .limit(limit)
        )
    )
