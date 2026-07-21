import uuid
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.db.session import get_session
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunEventResponse, RunStateResponse
from app.services.auth.dependencies import get_current_user
from app.services.run_events.stream import RedisRunEventStream
from app.services.runs.events import RunEvent
from app.services.runs.service import (
    TERMINAL_EVENT_TYPES,
    cancel_owned_run,
    get_owned_run_state,
    get_owned_visible_run,
    list_run_events_after,
)
from app.services.runs.streaming import iter_run_events

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


def _get_run_event_stream(request: Request) -> RedisRunEventStream | None:
    return getattr(request.app.state, "run_event_stream", None)


@router.get(
    "/{run_id}/state",
    response_model=SuccessResponse[RunStateResponse],
)
async def get_run_state_route(
    run_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    event_stream: Annotated[
        RedisRunEventStream | None,
        Depends(_get_run_event_stream),
    ],
) -> SuccessResponse[RunStateResponse]:
    state = await get_owned_run_state(
        session,
        user=current_user,
        run_public_id=run_id,
        event_stream=event_stream,
    )
    return SuccessResponse(data=state)


@router.post(
    "/{run_id}/cancel",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def cancel_run_route(
    run_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    event_stream: Annotated[
        RedisRunEventStream | None,
        Depends(_get_run_event_stream),
    ],
) -> SuccessResponse[CommandStatusResponse]:
    result = await cancel_owned_run(session, user=current_user, run_public_id=run_id)
    await session.commit()
    if event_stream is not None:
        visible_run = await get_owned_visible_run(
            session,
            user=current_user,
            run_public_id=run_id,
        )
        events = await list_run_events_after(session, run_id=visible_run.id, after_seq=0)
        terminal = next(
            (event for event in reversed(events) if event.type in TERMINAL_EVENT_TYPES),
            None,
        )
        if terminal is not None:
            try:
                await event_stream.append(
                    visible_run.id,
                    RunEvent(
                        seq=terminal.seq,
                        type=terminal.type,
                        payload=terminal.payload,
                    ),
                    created_at=terminal.created_at,
                    terminal=True,
                )
            except Exception as exc:
                logger.bind(run_id=visible_run.id, error=str(exc)).warning(
                    "Redis cancel event append failed; PostgreSQL remains authoritative"
                )
    return SuccessResponse(data=result)


@router.get("/{run_id}/events")
async def stream_run_events_route(
    run_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    event_stream_store: Annotated[
        RedisRunEventStream | None,
        Depends(_get_run_event_stream),
    ],
    after_seq: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse:
    run = await get_owned_visible_run(session, user=current_user, run_public_id=run_id)
    internal_run_id = run.id

    async def event_stream() -> AsyncIterator[str]:
        async for event in iter_run_events(
            session,
            run_id=internal_run_id,
            after_seq=after_seq,
            event_stream=event_stream_store,
        ):
            yield format_sse_event(event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def format_sse_event(event: RunEventResponse) -> str:
    return f"id: {event.seq}\nevent: {event.type}\ndata: {event.model_dump_json()}\n\n"
