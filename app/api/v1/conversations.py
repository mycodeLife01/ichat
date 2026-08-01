import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.core.logging import logger
from app.db.session import get_session
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationCreateRequest,
    ConversationCreateWithMessageRequest,
    ConversationCreateWithMessageResponse,
    ConversationDetailResponse,
    ConversationRenameRequest,
    ConversationResponse,
    MessageCreateRequest,
    RunOptionsRequest,
    SendMessageResponse,
)
from app.schemas.responses import SuccessResponse
from app.schemas.shares import ShareCreateRequest, ShareLinkResponse
from app.services.agents.catalog import ChatModel, resolve_chat_model
from app.services.agents.registry import resolve_provider
from app.services.auth.dependencies import get_current_user
from app.services.conversations.service import (
    create_conversation,
    create_conversation_with_message,
    delete_conversation,
    edit_user_message_and_regenerate,
    get_conversation_detail,
    get_internal_run_id,
    list_conversations,
    list_deleted_conversations,
    regenerate_from_message,
    rename_conversation,
    restore_conversation,
    submit_user_message,
)
from app.services.runs.wakeup import RunQueuedPublisher
from app.services.shares.service import (
    create_share,
    list_shares,
    revoke_share,
)

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])


def _get_run_queued_publisher(request: Request) -> RunQueuedPublisher | None:
    return getattr(request.app.state, "run_queued_publisher", None)


async def _publish_run_queued(
    publisher: RunQueuedPublisher | None,
    *,
    run_id: int,
) -> None:
    if publisher is None:
        return
    try:
        await publisher.publish(run_id)
    except Exception as exc:
        logger.bind(run_id=run_id, error=str(exc)).warning(
            "Run queued publish failed; worker polling fallback will claim it"
        )


_WEB_SEARCH_NEGATION_MARKERS = (
    "不要联网",
    "别联网",
    "不用联网",
    "不要搜索",
    "别搜索",
    "不用搜索",
    "不要查网页",
    "别查网页",
    "无需联网",
    "无需搜索",
    "no web search",
    "without web search",
    "don't search",
    "dont search",
    "do not search",
    "no internet",
    "without internet",
)


def user_suppresses_web_search(content: str) -> bool:
    normalized = content.lower()
    return any(marker in normalized for marker in _WEB_SEARCH_NEGATION_MARKERS)


def resolve_chat_selection(
    settings: Settings, request: RunOptionsRequest | None
) -> ChatModel:
    """Validate the request's optional ``model`` against the catalog.

    Raises a 422 ``AppError`` for models the server does not offer, so a run is
    only ever persisted with a (provider, model) pair the worker can execute.
    """
    return resolve_chat_model(settings, request.model if request is not None else None)


def resolve_provider_options(
    settings: Settings,
    request: RunOptionsRequest | None,
    *,
    content: str | None = None,
) -> dict[str, Any]:
    """Resolve per-request thinking overrides against env defaults.

    The result is persisted on the run so the worker replays the exact
    options the request was accepted with.
    """
    thinking_enabled = settings.deepseek_thinking_enabled
    reasoning_effort = settings.deepseek_reasoning_effort
    if request is not None:
        if request.thinking_enabled is not None:
            thinking_enabled = request.thinking_enabled
        if request.reasoning_effort is not None:
            reasoning_effort = request.reasoning_effort
    web_search_requested = bool(request.web_search_enabled) if request is not None else False
    web_search_suppressed = bool(
        content and web_search_requested and user_suppresses_web_search(content)
    )
    web_search_enabled = (
        web_search_requested and settings.web_search_available and not web_search_suppressed
    )
    return {
        "thinking_enabled": thinking_enabled,
        "reasoning_effort": reasoning_effort,
        "web_search_enabled": web_search_enabled,
        "web_search_suppressed_by_user": web_search_suppressed,
    }


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[ConversationResponse],
)
async def create_conversation_route(
    request: ConversationCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationResponse]:
    conversation = await create_conversation(
        session,
        user=current_user,
        title=request.title,
    )
    await session.commit()
    return SuccessResponse(data=conversation)


@router.post(
    "/with-message",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[ConversationCreateWithMessageResponse],
)
async def create_conversation_with_message_route(
    request: ConversationCreateWithMessageRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    run_queued_publisher: Annotated[
        RunQueuedPublisher | None,
        Depends(_get_run_queued_publisher),
    ],
) -> SuccessResponse[ConversationCreateWithMessageResponse]:
    chat_model = resolve_chat_selection(settings, request)
    count_tokens = resolve_provider(chat_model.provider_name, settings=settings).count_tokens
    result = await create_conversation_with_message(
        session,
        user=current_user,
        title=request.title,
        content=request.content,
        provider_name=chat_model.provider_name,
        provider_model=chat_model.model,
        provider_options=resolve_provider_options(settings, request, content=request.content),
        attachment_ids=request.attachment_ids or [],
        settings=settings,
        count_tokens=count_tokens,
    )
    internal_run_id = await get_internal_run_id(session, run_public_id=result.run.id)
    await session.commit()
    await _publish_run_queued(run_queued_publisher, run_id=internal_run_id)
    return SuccessResponse(data=result)


@router.get(
    "",
    response_model=SuccessResponse[list[ConversationResponse]],
)
async def list_conversations_route(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    limit: Annotated[int | None, Query(ge=1, le=100)] = None,
    skip: Annotated[int, Query(ge=0)] = 0,
) -> SuccessResponse[list[ConversationResponse]]:
    conversations = await list_conversations(
        session,
        user=current_user,
        limit=limit,
        skip=skip,
    )
    return SuccessResponse(data=conversations)


@router.get(
    "/deleted",
    response_model=SuccessResponse[list[ConversationResponse]],
)
async def list_deleted_conversations_route(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[list[ConversationResponse]]:
    return SuccessResponse(
        data=await list_deleted_conversations(session, user=current_user)
    )


@router.get(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationDetailResponse],
)
async def get_conversation_route(
    conversation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationDetailResponse]:
    conversation = await get_conversation_detail(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
    )
    return SuccessResponse(data=conversation)


@router.patch(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationResponse],
)
async def rename_conversation_route(
    conversation_id: uuid.UUID,
    request: ConversationRenameRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationResponse]:
    conversation = await rename_conversation(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
        title=request.title,
    )
    await session.commit()
    return SuccessResponse(data=conversation)


@router.delete(
    "/{conversation_id}",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def delete_conversation_route(
    conversation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CommandStatusResponse]:
    result = await delete_conversation(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
    )
    await session.commit()
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/restore",
    response_model=SuccessResponse[ConversationResponse],
)
async def restore_conversation_route(
    conversation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationResponse]:
    result = await restore_conversation(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
    )
    await session.commit()
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def send_message_route(
    conversation_id: uuid.UUID,
    request: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    run_queued_publisher: Annotated[
        RunQueuedPublisher | None,
        Depends(_get_run_queued_publisher),
    ],
) -> SuccessResponse[SendMessageResponse]:
    chat_model = resolve_chat_selection(settings, request)
    count_tokens = resolve_provider(chat_model.provider_name, settings=settings).count_tokens
    result = await submit_user_message(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
        content=request.content,
        provider_name=chat_model.provider_name,
        provider_model=chat_model.model,
        provider_options=resolve_provider_options(settings, request, content=request.content),
        attachment_ids=request.attachment_ids or [],
        settings=settings,
        count_tokens=count_tokens,
    )
    internal_run_id = await get_internal_run_id(session, run_public_id=result.run.id)
    await session.commit()
    await _publish_run_queued(run_queued_publisher, run_id=internal_run_id)
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages/{message_id}/edit-and-regenerate",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def edit_and_regenerate_route(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    request: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    run_queued_publisher: Annotated[
        RunQueuedPublisher | None,
        Depends(_get_run_queued_publisher),
    ],
) -> SuccessResponse[SendMessageResponse]:
    chat_model = resolve_chat_selection(settings, request)
    if "attachment_ids" in request.model_fields_set and request.attachment_ids is None:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "attachment_ids must be an array when provided",
        )
    count_tokens = resolve_provider(chat_model.provider_name, settings=settings).count_tokens
    result = await edit_user_message_and_regenerate(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
        message_public_id=message_id,
        new_content=request.content,
        provider_name=chat_model.provider_name,
        provider_model=chat_model.model,
        provider_options=resolve_provider_options(settings, request, content=request.content),
        attachment_ids=(
            request.attachment_ids if "attachment_ids" in request.model_fields_set else None
        ),
        settings=settings,
        count_tokens=count_tokens,
    )
    internal_run_id = await get_internal_run_id(session, run_public_id=result.run.id)
    await session.commit()
    await _publish_run_queued(run_queued_publisher, run_id=internal_run_id)
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages/{message_id}/regenerate",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def regenerate_route(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    run_queued_publisher: Annotated[
        RunQueuedPublisher | None,
        Depends(_get_run_queued_publisher),
    ],
    request: RunOptionsRequest | None = None,
) -> SuccessResponse[SendMessageResponse]:
    chat_model = resolve_chat_selection(settings, request)
    count_tokens = resolve_provider(chat_model.provider_name, settings=settings).count_tokens
    result = await regenerate_from_message(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
        message_public_id=message_id,
        provider_name=chat_model.provider_name,
        provider_model=chat_model.model,
        provider_options=resolve_provider_options(settings, request),
        settings=settings,
        count_tokens=count_tokens,
    )
    internal_run_id = await get_internal_run_id(session, run_public_id=result.run.id)
    await session.commit()
    await _publish_run_queued(run_queued_publisher, run_id=internal_run_id)
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/shares",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[ShareLinkResponse],
)
async def create_share_route(
    conversation_id: uuid.UUID,
    request: ShareCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ShareLinkResponse]:
    share = await create_share(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
        expires_in_days=request.expires_in_days,
        confirm_attachment_privacy=request.confirm_attachment_privacy,
    )
    await session.commit()
    return SuccessResponse(data=share)


@router.get(
    "/{conversation_id}/shares",
    response_model=SuccessResponse[list[ShareLinkResponse]],
)
async def list_shares_route(
    conversation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[list[ShareLinkResponse]]:
    shares = await list_shares(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
    )
    return SuccessResponse(data=shares)


@router.delete(
    "/{conversation_id}/shares/{share_token}",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def revoke_share_route(
    conversation_id: uuid.UUID,
    share_token: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CommandStatusResponse]:
    result = await revoke_share(
        session,
        user=current_user,
        conversation_public_id=conversation_id,
        token=share_token,
    )
    await session.commit()
    return SuccessResponse(data=result)
