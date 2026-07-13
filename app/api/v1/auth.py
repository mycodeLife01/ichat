from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.models.user import User
from app.schemas.auth import (
    AuthTokenResponse,
    AuthUserResponse,
    CommandStatusResponse,
    LoginRequest,
    LogoutRequest,
    RefreshTokenRequest,
    RegisterRequest,
    RequestPasswordResetRequest,
    ResetPasswordRequest,
    VerifyEmailRequest,
)
from app.schemas.responses import SuccessResponse
from app.services.auth import orchestration, rate_limit
from app.services.auth.dependencies import get_current_user
from app.services.auth.service import (
    login_user,
    logout,
    refresh_tokens,
    user_response,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[AuthTokenResponse],
    response_model_exclude_none=True,
)
async def register(
    request: Request,
    body: RegisterRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
) -> SuccessResponse[AuthTokenResponse]:
    token_response = await orchestration.register_with_verification(
        session,
        redis,
        username=body.username,
        email=str(body.email),
        password=body.password,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
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


@router.get(
    "/me",
    response_model=SuccessResponse[AuthUserResponse],
    response_model_exclude_none=True,
)
async def me(
    user: Annotated[User, Depends(get_current_user)],
) -> SuccessResponse[AuthUserResponse]:
    return SuccessResponse(data=user_response(user))


@router.post(
    "/verify-email",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def verify_email_route(
    request: Request,
    body: VerifyEmailRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
) -> SuccessResponse[CommandStatusResponse]:
    await orchestration.verify_email_address(
        session,
        redis,
        raw_token=body.token,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
    return SuccessResponse(data=CommandStatusResponse())


@router.post(
    "/resend-verification-email",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def resend_verification_email(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    user: Annotated[User, Depends(get_current_user)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
) -> SuccessResponse[CommandStatusResponse]:
    await orchestration.resend_verification_email(
        session,
        redis,
        user=user,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
    return SuccessResponse(data=CommandStatusResponse())


@router.post(
    "/request-password-reset",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def request_password_reset(
    request: Request,
    body: RequestPasswordResetRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
) -> SuccessResponse[CommandStatusResponse]:
    await orchestration.request_password_reset(
        session,
        redis,
        email=str(body.email),
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
    return SuccessResponse(data=CommandStatusResponse())


@router.post(
    "/reset-password",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
) -> SuccessResponse[CommandStatusResponse]:
    await orchestration.reset_password(
        session,
        redis,
        raw_token=body.token,
        new_password=body.new_password,
        client_ip=rate_limit.client_ip_from_request(request),
        settings=settings,
    )
    return SuccessResponse(data=CommandStatusResponse())
