import uuid
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, cast

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.logging import logger
from app.models.conversation import Conversation
from app.models.run import Run, RunDraft, RunEvent
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.runs import (
    RunEventResponse,
    RunEventType,
    RunStateResponse,
    RunStatus,
    RunToolSourceResponse,
    RunToolStateResponse,
)
from app.services.runs.drafts import get_run_draft

RUN_NOT_FOUND_MESSAGE = "Run not found"
TERMINAL_EVENT_TYPES: tuple[RunEventType, ...] = (
    "run_succeeded",
    "run_failed",
    "run_cancelled",
)
CANCEL_DIRECT_STATUSES = ("queued",)
CANCEL_REQUEST_STATUSES = ("started", "streaming")
CANCEL_IDEMPOTENT_STATUSES = ("cancelling", "succeeded", "failed", "cancelled")


class RunEventReader(Protocol):
    async def list_after(
        self,
        run_id: int,
        *,
        after_seq: int,
    ) -> list[RunEventResponse]: ...


def run_event_response(event: RunEvent) -> RunEventResponse:
    return RunEventResponse.model_validate(event)


async def get_owned_visible_run(
    session: AsyncSession,
    *,
    user: User,
    run_public_id: uuid.UUID,
) -> Run:
    run = await session.scalar(
        select(Run)
        .join(Conversation, Run.conversation_id == Conversation.id)
        .where(
            Run.public_id == run_public_id,
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
    run_public_id: uuid.UUID,
) -> CommandStatusResponse:
    run = await session.scalar(
        select(Run)
        .join(Conversation, Run.conversation_id == Conversation.id)
        .where(
            Run.public_id == run_public_id,
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
    seq: int | None = None,
) -> RunEventResponse:
    run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)

    event_seq = seq
    if event_seq is None:
        event_seq = await get_next_run_event_seq(session, run_id=run.id)
    event = RunEvent(
        run_id=run.id,
        seq=event_seq,
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
    run_public_id: uuid.UUID,
    after_seq: int,
) -> list[RunEventResponse]:
    run = await get_owned_visible_run(session, user=user, run_public_id=run_public_id)
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
    run_public_id: uuid.UUID,
    event_stream: RunEventReader | None = None,
) -> RunStateResponse:
    run = await get_owned_visible_run(session, user=user, run_public_id=run_public_id)
    events = (
        await session.scalars(
            select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.seq.asc())
        )
    ).all()

    latest_seq = 0
    latest_persisted_delta_seq = 0
    draft_text = ""
    draft_reasoning = ""
    terminal_event: RunEventResponse | None = None
    tool_state: RunToolStateResponse | None = None

    for event in events:
        latest_seq = max(latest_seq, event.seq)
        if event.type == "text_delta":
            text = event.payload.get("text")
            if isinstance(text, str):
                draft_text += text
                latest_persisted_delta_seq = event.seq
        if event.type == "reasoning_delta":
            text = event.payload.get("text")
            if isinstance(text, str):
                draft_reasoning += text
                latest_persisted_delta_seq = event.seq
        if event.type in TERMINAL_EVENT_TYPES:
            terminal_event = run_event_response(event)
        if event.type in {"tool_call_started", "tool_call_succeeded", "tool_call_failed"}:
            tool_state = _tool_state_from_event(event)

    draft = await get_run_draft(session, run_id=run.id)
    stream_after_seq = latest_persisted_delta_seq
    if draft is not None and draft.seq >= latest_persisted_delta_seq:
        draft_text = draft.text
        draft_reasoning = draft.reasoning
        latest_seq = max(latest_seq, draft.seq)
        stream_after_seq = draft.seq

    if event_stream is not None:
        try:
            stream_events = await event_stream.list_after(run.id, after_seq=stream_after_seq)
        except Exception as exc:
            logger.bind(run_id=run.id, error=str(exc)).warning(
                "Redis run state read failed; using PostgreSQL checkpoint"
            )
        else:
            for stream_event in stream_events:
                latest_seq = max(latest_seq, stream_event.seq)
                text = stream_event.payload.get("text")
                if stream_event.type == "text_delta" and isinstance(text, str):
                    draft_text += text
                elif stream_event.type == "reasoning_delta" and isinstance(text, str):
                    draft_reasoning += text

    return RunStateResponse(
        run_id=run.public_id,
        status=cast(RunStatus, run.status),
        latest_seq=latest_seq,
        draft_text=draft_text,
        draft_reasoning=draft_reasoning,
        tool_state=tool_state,
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
    event_max = await session.scalar(
        select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id)
    )
    draft_seq = await session.scalar(select(RunDraft.seq).where(RunDraft.run_id == run_id))
    return max(event_max or 0, draft_seq or 0) + 1


def _tool_state_from_event(event: RunEvent) -> RunToolStateResponse:
    payload = event.payload
    raw_sources = payload.get("sources")
    sources: list[RunToolSourceResponse] = []
    if isinstance(raw_sources, list):
        for item in raw_sources:
            if not isinstance(item, dict):
                continue
            sources.append(
                RunToolSourceResponse(
                    id=int(item.get("id", 0)),
                    title=str(item.get("title", "")),
                    url=str(item.get("url", "")),
                )
            )
    if event.type == "tool_call_started":
        status_value: Literal["running", "succeeded", "failed"] = "running"
    elif event.type == "tool_call_succeeded":
        status_value = "succeeded"
    else:
        status_value = "failed"
    query = payload.get("query")
    message = payload.get("message")
    result_count = payload.get("result_count")
    return RunToolStateResponse(
        status=status_value,
        tool_name=str(payload.get("tool_name", "web_search")),
        query=query if isinstance(query, str) else None,
        message=message if isinstance(message, str) else None,
        result_count=result_count if isinstance(result_count, int) else None,
        sources=sources,
    )
