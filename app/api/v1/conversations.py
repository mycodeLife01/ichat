from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationCreateRequest,
    ConversationDetailResponse,
    ConversationRenameRequest,
    ConversationResponse,
    MessageCreateRequest,
    RunOptionsRequest,
    SendMessageResponse,
)
from app.schemas.responses import SuccessResponse
from app.services.auth.dependencies import get_current_user
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    edit_user_message_and_regenerate,
    get_conversation_detail,
    list_conversations,
    regenerate_from_message,
    rename_conversation,
    submit_user_message,
)

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])


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


@router.get(
    "",
    response_model=SuccessResponse[list[ConversationResponse]],
)
async def list_conversations_route(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[list[ConversationResponse]]:
    conversations = await list_conversations(session, user=current_user)
    return SuccessResponse(data=conversations)


@router.get(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationDetailResponse],
)
async def get_conversation_route(
    conversation_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationDetailResponse]:
    conversation = await get_conversation_detail(
        session,
        user=current_user,
        conversation_id=conversation_id,
    )
    return SuccessResponse(data=conversation)


@router.patch(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationResponse],
)
async def rename_conversation_route(
    conversation_id: int,
    request: ConversationRenameRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationResponse]:
    conversation = await rename_conversation(
        session,
        user=current_user,
        conversation_id=conversation_id,
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
    conversation_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CommandStatusResponse]:
    result = await delete_conversation(
        session,
        user=current_user,
        conversation_id=conversation_id,
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
    conversation_id: int,
    request: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[SendMessageResponse]:
    result = await submit_user_message(
        session,
        user=current_user,
        conversation_id=conversation_id,
        content=request.content,
        provider_name="deepseek",
        provider_model=settings.deepseek_model,
        provider_options=resolve_provider_options(settings, request, content=request.content),
        system_prompt_snapshot=settings.default_system_prompt,
    )
    await session.commit()
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages/{message_id}/edit-and-regenerate",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def edit_and_regenerate_route(
    conversation_id: int,
    message_id: int,
    request: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[SendMessageResponse]:
    result = await edit_user_message_and_regenerate(
        session,
        user=current_user,
        conversation_id=conversation_id,
        message_id=message_id,
        new_content=request.content,
        provider_name="deepseek",
        provider_model=settings.deepseek_model,
        provider_options=resolve_provider_options(settings, request, content=request.content),
        system_prompt_snapshot=settings.default_system_prompt,
    )
    await session.commit()
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages/{message_id}/regenerate",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def regenerate_route(
    conversation_id: int,
    message_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
    request: RunOptionsRequest | None = None,
) -> SuccessResponse[SendMessageResponse]:
    result = await regenerate_from_message(
        session,
        user=current_user,
        conversation_id=conversation_id,
        message_id=message_id,
        provider_name="deepseek",
        provider_model=settings.deepseek_model,
        provider_options=resolve_provider_options(settings, request),
        system_prompt_snapshot=settings.default_system_prompt,
    )
    await session.commit()
    return SuccessResponse(data=result)
