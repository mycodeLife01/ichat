from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.user import User
from app.schemas.responses import SuccessResponse
from app.schemas.shares import UserShareResponse
from app.services.auth.dependencies import get_current_user
from app.services.shares.service import list_user_shares

router = APIRouter(prefix="/api/v1/shares", tags=["shares"])


@router.get("", response_model=SuccessResponse[list[UserShareResponse]])
async def list_user_shares_route(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[list[UserShareResponse]]:
    shares = await list_user_shares(session, user=user)
    return SuccessResponse(data=shares)
