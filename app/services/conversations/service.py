from datetime import datetime

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
    RunResponse,
    SendMessageResponse,
)

CONVERSATION_NOT_FOUND_MESSAGE = "Conversation not found"
ACTIVE_RUN_STATUSES = ("queued", "started", "streaming", "cancelling")
ACTIVE_RUN_EXISTS_MESSAGE = "Active run already exists"


def conversation_response(conversation: Conversation) -> ConversationResponse:
    return ConversationResponse.model_validate(conversation)


def message_response(message: Message) -> MessageResponse:
    return MessageResponse.model_validate(message)


def run_response(run: Run) -> RunResponse:
    return RunResponse.model_validate(run)


async def create_conversation(
    session: AsyncSession,
    *,
    user: User,
    title: str | None,
) -> ConversationResponse:
    conversation = Conversation(user_id=user.id, title=normalize_optional_title(title))
    session.add(conversation)
    await session.flush()
    return conversation_response(conversation)


async def list_conversations(
    session: AsyncSession,
    *,
    user: User,
) -> list[ConversationResponse]:
    conversations = (
        await session.scalars(
            select(Conversation)
            .where(
                Conversation.user_id == user.id,
                Conversation.deleted_at.is_(None),
            )
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
        )
    ).all()
    return [conversation_response(conversation) for conversation in conversations]


async def get_conversation_detail(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> ConversationDetailResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    messages = (
        await session.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation.id,
                Message.archived_at.is_(None),
            )
            .order_by(Message.position.asc())
        )
    ).all()
    return ConversationDetailResponse(
        **conversation_response(conversation).model_dump(),
        messages=[message_response(message) for message in messages],
    )


async def rename_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
    title: str,
) -> ConversationResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    conversation.title = title.strip()
    conversation.updated_at = await get_database_now(session)
    await session.flush()
    await session.refresh(conversation)
    return conversation_response(conversation)


async def delete_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> CommandStatusResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    now = await get_database_now(session)
    conversation.deleted_at = now
    conversation.updated_at = now
    await session.flush()
    return CommandStatusResponse()


async def submit_user_message(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
    content: str,
    provider_name: str,
    provider_model: str,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    await ensure_no_active_run(session, conversation_id=conversation.id)
    next_position = await get_next_message_position(session, conversation_id=conversation.id)

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content=content,
        position=next_position,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="queued",
        provider_name=provider_name,
        provider_model=provider_model,
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    conversation.updated_at = await get_database_now(session)
    await session.flush()

    return SendMessageResponse(
        message=message_response(message),
        run=run_response(run),
    )


async def get_owned_visible_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
    )
    if conversation is None:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    return conversation


async def get_owned_visible_conversation_for_update(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if conversation is None:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    return conversation


async def ensure_no_active_run(session: AsyncSession, *, conversation_id: int) -> None:
    active_run_id = await session.scalar(
        select(Run.id).where(
            Run.conversation_id == conversation_id,
            Run.status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if active_run_id is not None:
        raise AppError(status.HTTP_409_CONFLICT, ACTIVE_RUN_EXISTS_MESSAGE)


async def get_next_message_position(session: AsyncSession, *, conversation_id: int) -> int:
    max_position = await session.scalar(
        select(func.max(Message.position)).where(Message.conversation_id == conversation_id)
    )
    if max_position is None:
        return 1
    return max_position + 1


async def get_database_now(session: AsyncSession) -> datetime:
    now = await session.scalar(select(func.now()))
    if now is None:
        raise RuntimeError("Database time is unavailable")
    return now


def normalize_optional_title(title: str | None) -> str | None:
    if title is None:
        return None
    normalized = title.strip()
    return normalized or None
