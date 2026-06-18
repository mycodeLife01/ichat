import asyncio
import contextlib
import uuid
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_session
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunEventResponse, RunStateResponse
from app.services.auth.dependencies import get_current_user
from app.services.run_events.subscription import RunEventSubscriptionManager
from app.services.runs.service import (
    TERMINAL_EVENT_TYPES,
    cancel_owned_run,
    get_owned_run_state,
    get_owned_visible_run,
    list_run_events_after,
    run_has_terminal_event,
)

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


def _get_subscription_manager(request: Request) -> RunEventSubscriptionManager | None:
    return getattr(request.app.state, "run_event_subscriptions", None)


@router.get(
    "/{run_id}/state",
    response_model=SuccessResponse[RunStateResponse],
)
async def get_run_state_route(
    run_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[RunStateResponse]:
    state = await get_owned_run_state(session, user=current_user, run_public_id=run_id)
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
) -> SuccessResponse[CommandStatusResponse]:
    result = await cancel_owned_run(session, user=current_user, run_public_id=run_id)
    await session.commit()
    return SuccessResponse(data=result)


@router.get("/{run_id}/events")
async def stream_run_events_route(
    run_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    manager: Annotated[
        RunEventSubscriptionManager | None, Depends(_get_subscription_manager)
    ],
    after_seq: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse:
    run = await get_owned_visible_run(session, user=current_user, run_public_id=run_id)
    # Internal id drives event replay and pg_notify wakeups; the public id is
    # only the addressable handle on the URL.
    internal_run_id = run.id
    fallback_interval = get_settings().sse_fallback_interval_seconds

    async def event_stream() -> AsyncIterator[str]:
        cursor = after_seq
        wake = manager.subscribe(internal_run_id) if manager is not None else None
        try:
            while True:
                events = await list_run_events_after(
                    session, run_id=internal_run_id, after_seq=cursor
                )
                for event in events:
                    cursor = event.seq
                    yield format_sse_event(event)
                    if event.type in TERMINAL_EVENT_TYPES:
                        return

                if await run_has_terminal_event(session, run_id=internal_run_id):
                    return

                await session.rollback()

                if wake is not None:
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(wake.wait(), timeout=fallback_interval)
                    wake.clear()
                else:
                    await asyncio.sleep(fallback_interval)
        finally:
            if manager is not None and wake is not None:
                manager.unsubscribe(internal_run_id, wake)

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
