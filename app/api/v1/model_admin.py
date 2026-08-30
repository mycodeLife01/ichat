import secrets
from collections.abc import Awaitable
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Header, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.db.session import get_session
from app.schemas.model_admin import (
    EnabledRequest,
    ImportEnvironmentCatalogRequest,
    ModelAdminCatalogResponse,
    ModelAdminChatModelResponse,
    ModelAdminRouteResponse,
    ModelAdminUpstreamResponse,
    ProviderAdapter,
    ReasoningOutput,
    SetCatalogStateRequest,
    SetModelRouteEnabledRequest,
    ThinkingLevel,
    TokenProfile,
    UpsertChatModelRequest,
    UpsertModelRouteRequest,
    UpsertModelUpstreamRequest,
)
from app.schemas.responses import SuccessResponse
from app.services.auth import rate_limit
from app.services.model_catalog import management
from app.services.model_catalog.credentials import ModelCredentialError
from app.services.model_catalog.service import ModelCatalogError

MODEL_ADMIN_KEY_HEADER = "X-Model-Admin-Key"
_INVALID_KEY_MESSAGE = "Invalid model management access key"
_FAILURE_LIMIT = 10
_FAILURE_WINDOW_SECONDS = 15 * 60


async def require_model_admin_access(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    redis: Annotated[Redis, Depends(rate_limit.get_redis)],
    access_key: Annotated[str | None, Header(alias=MODEL_ADMIN_KEY_HEADER)] = None,
) -> None:
    candidate = access_key or ""
    configured = settings.model_admin_access_key
    if configured and secrets.compare_digest(
        candidate.encode("utf-8"), configured.encode("utf-8")
    ):
        return

    failure_key = (
        "model_admin:fail:access:ip:"
        f"{rate_limit.client_ip_from_request(request)}"
    )
    try:
        budget = await rate_limit.check_failure_budget(
            redis,
            failure_key,
            limit=_FAILURE_LIMIT,
        )
        if not budget.allowed:
            raise AppError(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many invalid model management access attempts",
                headers={"Retry-After": str(budget.retry_after_seconds)},
            )
        await rate_limit.record_failure(
            redis,
            failure_key,
            window_seconds=_FAILURE_WINDOW_SECONDS,
        )
    except AppError:
        raise
    except Exception:  # noqa: BLE001 - invalid access still fails when Redis is unavailable
        pass
    raise AppError(
        status.HTTP_401_UNAUTHORIZED,
        _INVALID_KEY_MESSAGE,
        headers={"WWW-Authenticate": "ModelAdminKey"},
    )


router = APIRouter(
    prefix="/api/v1/model-admin",
    tags=["model-admin"],
    dependencies=[Depends(require_model_admin_access)],
)


@router.get(
    "",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def get_model_catalog(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return SuccessResponse(data=await _catalog_response(session))


@router.put(
    "/models/{model_key}",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def put_chat_model(
    model_key: str,
    body: UpsertChatModelRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return await _mutate(
        session,
        management.upsert_chat_model(
            session,
            key=model_key,
            label=body.label,
            thinking_levels=list(body.thinking_levels),
            supports_image_input=body.supports_image_input,
            image_token_reserve=body.image_token_reserve,
            token_profile=body.token_profile,
            sort_order=body.sort_order,
            enabled=body.enabled,
            settings=settings,
        ),
    )


@router.patch(
    "/models/{model_key}/enabled",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def patch_chat_model_enabled(
    model_key: str,
    body: EnabledRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return await _mutate(
        session,
        management.set_chat_model_enabled(session, key=model_key, enabled=body.enabled),
    )


@router.put(
    "/upstreams/{upstream_key}",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def put_model_upstream(
    upstream_key: str,
    body: UpsertModelUpstreamRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    api_key = body.api_key.get_secret_value() if body.api_key is not None else None
    return await _mutate(
        session,
        management.upsert_model_upstream(
            session,
            key=upstream_key,
            label=body.label,
            adapter=body.adapter,
            base_url=body.base_url,
            api_key=api_key,
            settings=settings,
            enabled=body.enabled,
        ),
    )


@router.patch(
    "/upstreams/{upstream_key}/enabled",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def patch_model_upstream_enabled(
    upstream_key: str,
    body: EnabledRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return await _mutate(
        session,
        management.set_model_upstream_enabled(
            session,
            key=upstream_key,
            enabled=body.enabled,
        ),
    )


@router.put(
    "/routes",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def put_model_route(
    body: UpsertModelRouteRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return await _mutate(
        session,
        management.upsert_model_route(
            session,
            model_key=body.model_key,
            upstream_key=body.upstream_key,
            upstream_model=body.upstream_model,
            priority=body.priority,
            reasoning_outputs=list(body.reasoning_outputs),
            enabled=body.enabled,
        ),
    )


@router.patch(
    "/routes/enabled",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def patch_model_route_enabled(
    body: SetModelRouteEnabledRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return await _mutate(
        session,
        management.set_model_route_enabled(
            session,
            model_key=body.model_key,
            upstream_key=body.upstream_key,
            upstream_model=body.upstream_model,
            enabled=body.enabled,
        ),
    )


@router.patch(
    "/catalog",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def patch_catalog_state(
    body: SetCatalogStateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    return await _mutate(
        session,
        management.set_database_catalog_enabled(
            session,
            enabled=body.database_enabled,
            settings=settings,
        ),
    )


@router.post(
    "/import-env",
    response_model=SuccessResponse[ModelAdminCatalogResponse],
    response_model_exclude={"meta"},
)
async def post_import_environment_catalog(
    body: ImportEnvironmentCatalogRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    async def import_and_optionally_activate() -> None:
        await management.import_environment_catalog(session, settings=settings)
        if body.activate:
            await management.set_database_catalog_enabled(
                session,
                enabled=True,
                settings=settings,
            )

    return await _mutate(session, import_and_optionally_activate())


async def _mutate(
    session: AsyncSession,
    operation: Awaitable[object],
) -> SuccessResponse[ModelAdminCatalogResponse]:
    try:
        await operation
        response = SuccessResponse(data=await _catalog_response(session))
        await session.commit()
        return response
    except (ModelCatalogError, ModelCredentialError) as exc:
        await session.rollback()
        raise AppError(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


async def _catalog_response(session: AsyncSession) -> ModelAdminCatalogResponse:
    try:
        inventory = await management.catalog_inventory(session)
    except (ModelCatalogError, ModelCredentialError) as exc:
        raise AppError(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    model_keys = {model.id: model.key for model in inventory.models}
    upstream_keys = {upstream.id: upstream.key for upstream in inventory.upstreams}
    return ModelAdminCatalogResponse(
        database_enabled=inventory.database_enabled,
        models=[
            ModelAdminChatModelResponse(
                key=model.key,
                label=model.label,
                thinking_levels=cast(list[ThinkingLevel], model.thinking_levels),
                supports_image_input=model.supports_image_input,
                image_token_reserve=model.image_token_reserve,
                token_profile=cast(TokenProfile, model.token_profile),
                sort_order=model.sort_order,
                enabled=model.enabled,
            )
            for model in inventory.models
        ],
        upstreams=[
            ModelAdminUpstreamResponse(
                key=upstream.key,
                label=upstream.label,
                adapter=cast(ProviderAdapter, upstream.adapter),
                base_url=upstream.base_url,
                api_key_hint=upstream.api_key_hint,
                enabled=upstream.enabled,
            )
            for upstream in inventory.upstreams
        ],
        routes=[
            ModelAdminRouteResponse(
                model_key=model_keys[route.chat_model_id],
                upstream_key=upstream_keys[route.upstream_id],
                upstream_model=route.upstream_model,
                reasoning_outputs=cast(
                    list[ReasoningOutput], route.reasoning_outputs or []
                ),
                priority=route.priority,
                enabled=route.enabled,
                selected=route.id in inventory.selected_route_ids,
            )
            for route in inventory.routes
        ],
    )
