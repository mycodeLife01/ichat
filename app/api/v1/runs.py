import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.user import User
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunEventResponse, RunStateResponse
from app.services.auth.dependencies import get_current_user
from app.services.runs.service import (
    TERMINAL_EVENT_TYPES,
    get_owned_run_state,
    get_owned_visible_run,
    list_run_events_after,
    run_has_terminal_event,
)

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])
SSE_POLL_INTERVAL_SECONDS = 0.2


@router.get(
    "/{run_id}/state",
    response_model=SuccessResponse[RunStateResponse],
)
async def get_run_state_route(
    run_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[RunStateResponse]:
    state = await get_owned_run_state(session, user=current_user, run_id=run_id)
    return SuccessResponse(data=state)


@router.get("/{run_id}/events")
async def stream_run_events_route(
    run_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    after_seq: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse:
    await get_owned_visible_run(session, user=current_user, run_id=run_id)

    async def event_stream() -> AsyncIterator[str]:
        cursor = after_seq
        while True:
            events = await list_run_events_after(session, run_id=run_id, after_seq=cursor)
            for event in events:
                cursor = event.seq
                yield format_sse_event(event)
                if event.type in TERMINAL_EVENT_TYPES:
                    return

            if await run_has_terminal_event(session, run_id=run_id):
                return

            await asyncio.sleep(SSE_POLL_INTERVAL_SECONDS)

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
