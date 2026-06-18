from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.responses import SuccessResponse
from app.schemas.shares import PublicShareResponse
from app.services.shares.service import get_public_share

router = APIRouter(prefix="/api/v1/share", tags=["share"])


@router.get(
    "/{token}",
    response_model=SuccessResponse[PublicShareResponse],
)
async def get_public_share_route(
    token: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[PublicShareResponse]:
    # Public, unauthenticated by design: anyone with the token reads the frozen
    # snapshot. Scope is strictly the snapshot — no ownership, no live data.
    share = await get_public_share(session, token=token)
    return SuccessResponse(data=share)
