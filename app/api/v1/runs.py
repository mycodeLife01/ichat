from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.user import User
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunStateResponse
from app.services.auth.dependencies import get_current_user
from app.services.runs.service import get_owned_run_state

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


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
