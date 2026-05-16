from datetime import UTC, datetime

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

CONVERSATION_NOT_FOUND_MESSAGE = "Conversation not found"


def conversation_response(conversation: Conversation) -> ConversationResponse:
    return ConversationResponse.model_validate(conversation)


def message_response(message: Message) -> MessageResponse:
    return MessageResponse.model_validate(message)


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
    conversation.updated_at = datetime.now(UTC)
    await session.flush()
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
    now = datetime.now(UTC)
    conversation.deleted_at = now
    conversation.updated_at = now
    await session.flush()
    return CommandStatusResponse()


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


def normalize_optional_title(title: str | None) -> str | None:
    if title is None:
        return None
    normalized = title.strip()
    return normalized or None
