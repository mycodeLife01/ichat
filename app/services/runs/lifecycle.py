from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.run import Run, RunEvent
from app.services.runs.service import append_run_event


async def claim_next_queued_run(
    session: AsyncSession,
    *,
    worker_id: str,
    lease_seconds: int,
) -> int | None:
    run = await session.scalar(
        select(Run)
        .where(Run.status == "queued")
        .order_by(Run.created_at.asc(), Run.id.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if run is None:
        return None

    now = datetime.now(UTC)
    run.status = "started"
    run.lease_owner = worker_id
    run.lease_expires_at = now + timedelta(seconds=lease_seconds)
    run.heartbeat_at = now
    run.started_at = now
    await session.flush()
    await append_run_event(
        session,
        run_id=run.id,
        event_type="run_started",
        payload={},
    )
    return run.id


STARTED_STATUS = "started"
STREAMING_STATUS = "streaming"
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled")
SUCCEEDED_FROM_STATUSES = (STARTED_STATUS, STREAMING_STATUS)
FAILED_FROM_STATUSES = (STARTED_STATUS, STREAMING_STATUS, "cancelling")
CANCELLED_FROM_STATUSES = ("queued", STARTED_STATUS, STREAMING_STATUS, "cancelling")
RENEWABLE_STATUSES = (STARTED_STATUS, STREAMING_STATUS, "cancelling")


async def _get_run_for_update(session: AsyncSession, *, run_id: int) -> Run:
    run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    return run


async def mark_run_streaming(session: AsyncSession, *, run_id: int) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status != STARTED_STATUS:
        return False
    now = datetime.now(UTC)
    run.status = STREAMING_STATUS
    if run.first_streamed_at is None:
        run.first_streamed_at = now
    await session.flush()
    return True


async def mark_run_succeeded(
    session: AsyncSession,
    *,
    run_id: int,
    usage: dict[str, Any] | None,
    provider_request_id: str | None,
) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in SUCCEEDED_FROM_STATUSES:
        return False
    now = datetime.now(UTC)
    run.status = "succeeded"
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    run.usage_metadata = usage
    run.provider_request_id = provider_request_id
    await session.flush()
    await append_run_event(
        session,
        run_id=run_id,
        event_type="run_succeeded",
        payload={"usage": usage} if usage is not None else {},
    )
    return True


async def mark_run_failed(
    session: AsyncSession,
    *,
    run_id: int,
    code: str,
    message: str,
) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in FAILED_FROM_STATUSES:
        return False
    now = datetime.now(UTC)
    run.status = "failed"
    run.failed_at = now
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    run.error_code = code
    run.error_message = message
    await session.flush()
    await append_run_event(
        session,
        run_id=run_id,
        event_type="run_failed",
        payload={"code": code, "message": message},
    )
    return True


async def mark_run_cancelled(session: AsyncSession, *, run_id: int) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in CANCELLED_FROM_STATUSES:
        return False
    now = datetime.now(UTC)
    run.status = "cancelled"
    run.cancelled_at = now
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    await session.flush()
    await append_run_event(
        session,
        run_id=run_id,
        event_type="run_cancelled",
        payload={},
    )
    return True


async def renew_lease(
    session: AsyncSession,
    *,
    run_id: int,
    lease_seconds: int,
) -> bool:
    run = await _get_run_for_update(session, run_id=run_id)
    if run.status not in RENEWABLE_STATUSES or run.lease_owner is None:
        return False
    now = datetime.now(UTC)
    run.lease_expires_at = now + timedelta(seconds=lease_seconds)
    run.heartbeat_at = now
    await session.flush()
    return True


async def is_cancelling(session: AsyncSession, *, run_id: int) -> bool:
    status = await session.scalar(select(Run.status).where(Run.id == run_id))
    return status == "cancelling"


async def run_has_text_delta(session: AsyncSession, *, run_id: int) -> bool:
    event_id = await session.scalar(
        select(RunEvent.id)
        .where(RunEvent.run_id == run_id, RunEvent.type == "text_delta")
        .limit(1)
    )
    return event_id is not None


ACTIVE_STATUSES_FOR_RECOVERY = ("started", "streaming", "cancelling")


async def recover_expired_runs(session: AsyncSession) -> list[int]:
    now = datetime.now(UTC)
    candidate_ids = (
        await session.scalars(
            select(Run.id)
            .where(
                Run.status.in_(ACTIVE_STATUSES_FOR_RECOVERY),
                Run.lease_expires_at.is_not(None),
                Run.lease_expires_at < now,
            )
            .with_for_update(skip_locked=True)
        )
    ).all()

    recovered: list[int] = []
    for run_id in candidate_ids:
        changed = await mark_run_failed(
            session,
            run_id=run_id,
            code="lease_expired",
            message="worker lease expired",
        )
        if changed:
            recovered.append(run_id)
    return recovered
