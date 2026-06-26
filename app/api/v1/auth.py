from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from loguru import logger
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
    VerifyEmailRequest,
)
from app.schemas.responses import SuccessResponse
from app.services.auth import rate_limit, verification
from app.services.auth.dependencies import get_current_user
from app.services.auth.service import (
    login_user,
    logout,
    refresh_tokens,
    register_user,
    user_response,
)
from app.tasks.email_tasks import send_email_outbox

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _enqueue_email(outbox_id: int) -> None:
    """Best-effort Celery dispatch. The DB row is the source of truth; if the
    broker is down, celery-beat's sweep re-enqueues it later."""
    try:
        send_email_outbox.delay(outbox_id)
    except Exception:  # noqa: BLE001 - delivery must not fail the request
        logger.warning("Failed to enqueue email outbox {id}; sweep will recover", id=outbox_id)


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
) -> SuccessResponse[AuthTokenResponse]:
    redis = rate_limit.get_redis()
    client_ip = rate_limit.client_ip_from_request(request)
    # IP flood protection up front; the per-email cooldown runs only after the
    # unique-email check passes, so a duplicate email returns 409 (not a 429).
    await verification.register_ip_guard(redis, client_ip=client_ip, settings=settings)
    cooldown_key: str | None = None
    try:
        token_response = await register_user(
            session,
            username=body.username,
            email=str(body.email),
            password=body.password,
            jwt_secret=settings.jwt_secret,
            access_token_ttl_seconds=settings.jwt_access_token_ttl_seconds,
            refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
        )
        user = await session.get(User, token_response.user.id)
        assert user is not None  # just created in this transaction
        cooldown_key = await verification.acquire_register_email_cooldown(
            session, redis, email=str(body.email), settings=settings
        )
        outbox_id = await verification.create_verification_email(
            session, user=user, settings=settings
        )
        await session.commit()
    except Exception:
        await session.rollback()
        if cooldown_key is not None:
            await rate_limit.release_cooldown(redis, cooldown_key)
        raise
    _enqueue_email(outbox_id)
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
) -> SuccessResponse[CommandStatusResponse]:
    redis = rate_limit.get_redis()
    await verification.verify_ip_guard(
        redis, client_ip=rate_limit.client_ip_from_request(request), settings=settings
    )
    await verification.verify_email(session, raw_token=body.token)
    await session.commit()
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
) -> SuccessResponse[CommandStatusResponse]:
    # Already verified: succeed without sending (and without consuming a slot).
    if user.email_verified:
        return SuccessResponse(data=CommandStatusResponse())

    redis = rate_limit.get_redis()
    client_ip = rate_limit.client_ip_from_request(request)
    cooldown_key = await verification.resend_guard(
        redis, user=user, client_ip=client_ip, settings=settings
    )
    try:
        outbox_id = await verification.create_verification_email_for_user(
            session, user_id=user.id, settings=settings
        )
        await session.commit()
    except Exception:
        await session.rollback()
        if cooldown_key is not None:
            await rate_limit.release_cooldown(redis, cooldown_key)
        raise
    if outbox_id is not None:
        _enqueue_email(outbox_id)
    return SuccessResponse(data=CommandStatusResponse())
