from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.schemas.auth import (
    AuthTokenResponse,
    CommandStatusResponse,
    LoginRequest,
    LogoutRequest,
    RefreshTokenRequest,
    RegisterRequest,
)
from app.schemas.responses import SuccessResponse
from app.services.auth.service import login_user, logout, refresh_tokens, register_user

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[AuthTokenResponse],
    response_model_exclude_none=True,
)
async def register(
    request: RegisterRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[AuthTokenResponse]:
    token_response = await register_user(
        session,
        username=request.username,
        email=str(request.email),
        password=request.password,
        jwt_secret=settings.jwt_secret,
        access_token_ttl_seconds=settings.jwt_access_token_ttl_seconds,
        refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
    )
    await session.commit()
    return SuccessResponse(data=token_response)


@router.post(
    "/login",
    response_model=SuccessResponse[AuthTokenResponse],
    response_model_exclude_none=True,
)
async def login(
    request: LoginRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[AuthTokenResponse]:
    token_response = await login_user(
        session,
        identifier=request.identifier,
        password=request.password,
        jwt_secret=settings.jwt_secret,
        access_token_ttl_seconds=settings.jwt_access_token_ttl_seconds,
        refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
    )
    await session.commit()
    return SuccessResponse(data=token_response)


@router.post(
    "/refresh",
    response_model=SuccessResponse[AuthTokenResponse],
    response_model_exclude_none=True,
)
async def refresh(
    request: RefreshTokenRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[AuthTokenResponse]:
    token_response = await refresh_tokens(
        session,
        refresh_token=request.refresh_token,
        jwt_secret=settings.jwt_secret,
        access_token_ttl_seconds=settings.jwt_access_token_ttl_seconds,
        refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
    )
    await session.commit()
    return SuccessResponse(data=token_response)


@router.post(
    "/logout",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def logout_route(
    request: LogoutRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CommandStatusResponse]:
    status_response = await logout(session, refresh_token=request.refresh_token)
    await session.commit()
    return SuccessResponse(data=status_response)
