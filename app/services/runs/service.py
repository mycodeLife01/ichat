from datetime import UTC, datetime
from typing import Any, cast

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.conversation import Conversation
from app.models.run import Run, RunEvent
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.runs import RunEventResponse, RunEventType, RunStateResponse, RunStatus

RUN_NOT_FOUND_MESSAGE = "Run not found"
TERMINAL_EVENT_TYPES: tuple[RunEventType, ...] = (
    "run_succeeded",
    "run_failed",
    "run_cancelled",
)
CANCEL_DIRECT_STATUSES = ("queued",)
CANCEL_REQUEST_STATUSES = ("started", "streaming")
CANCEL_IDEMPOTENT_STATUSES = ("cancelling", "succeeded", "failed", "cancelled")


def run_event_response(event: RunEvent) -> RunEventResponse:
    return RunEventResponse.model_validate(event)


async def get_owned_visible_run(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
) -> Run:
    run = await session.scalar(
        select(Run)
        .join(Conversation, Run.conversation_id == Conversation.id)
        .where(
            Run.id == run_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
    )
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)
    return run


async def cancel_owned_run(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
) -> CommandStatusResponse:
    run = await session.scalar(
        select(Run)
        .join(Conversation, Run.conversation_id == Conversation.id)
        .where(
            Run.id == run_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
        .with_for_update(of=Run)
    )
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)

    if run.status in CANCEL_DIRECT_STATUSES:
        now = datetime.now(UTC)
        run.status = "cancelled"
        run.cancelled_at = now
        run.completed_at = now
        run.lease_owner = None
        run.lease_expires_at = None
        await session.flush()
        await append_run_event(
            session,
            run_id=run.id,
            event_type="run_cancelled",
            payload={},
        )
        return CommandStatusResponse()

    if run.status in CANCEL_REQUEST_STATUSES:
        run.status = "cancelling"
        await session.flush()
        return CommandStatusResponse()

    if run.status in CANCEL_IDEMPOTENT_STATUSES:
        return CommandStatusResponse()

    return CommandStatusResponse()


async def append_run_event(
    session: AsyncSession,
    *,
    run_id: int,
    event_type: RunEventType,
    payload: dict[str, Any],
) -> RunEventResponse:
    run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)

    next_seq = await get_next_run_event_seq(session, run_id=run.id)
    event = RunEvent(
        run_id=run.id,
        seq=next_seq,
        type=event_type,
        payload=payload,
    )
    session.add(event)
    await session.flush()
    return run_event_response(event)


async def list_owned_run_events_after(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
    after_seq: int,
) -> list[RunEventResponse]:
    run = await get_owned_visible_run(session, user=user, run_id=run_id)
    return await list_run_events_after(session, run_id=run.id, after_seq=after_seq)


async def list_run_events_after(
    session: AsyncSession,
    *,
    run_id: int,
    after_seq: int,
) -> list[RunEventResponse]:
    events = (
        await session.scalars(
            select(RunEvent)
            .where(
                RunEvent.run_id == run_id,
                RunEvent.seq > after_seq,
            )
            .order_by(RunEvent.seq.asc())
        )
    ).all()
    return [run_event_response(event) for event in events]


async def get_owned_run_state(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
) -> RunStateResponse:
    run = await get_owned_visible_run(session, user=user, run_id=run_id)
    events = (
        await session.scalars(
            select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.seq.asc())
        )
    ).all()

    latest_seq = 0
    draft_parts: list[str] = []
    terminal_event: RunEventResponse | None = None

    for event in events:
        latest_seq = event.seq
        if event.type == "text_delta":
            text = event.payload.get("text")
            if isinstance(text, str):
                draft_parts.append(text)
        if event.type in TERMINAL_EVENT_TYPES:
            terminal_event = run_event_response(event)

    return RunStateResponse(
        run_id=run.id,
        status=cast(RunStatus, run.status),
        latest_seq=latest_seq,
        draft_text="".join(draft_parts),
        terminal_event=terminal_event,
    )


async def run_has_terminal_event(session: AsyncSession, *, run_id: int) -> bool:
    event_id = await session.scalar(
        select(RunEvent.id)
        .where(
            RunEvent.run_id == run_id,
            RunEvent.type.in_(TERMINAL_EVENT_TYPES),
        )
        .limit(1)
    )
    return event_id is not None


async def get_next_run_event_seq(session: AsyncSession, *, run_id: int) -> int:
    max_seq = await session.scalar(select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id))
    if max_seq is None:
        return 1
    return max_seq + 1
