import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any, Literal, cast

from fastapi import status
from sqlalchemy import func, select, text, update
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
from app.schemas.runs import RunStatus

CONVERSATION_NOT_FOUND_MESSAGE = "Conversation not found"
ACTIVE_RUN_STATUSES = ("queued", "started", "streaming", "cancelling")
ACTIVE_RUN_EXISTS_MESSAGE = "Active run already exists"
MESSAGE_NOT_FOUND_MESSAGE = "Message not found"
EDIT_TARGET_NOT_USER_MESSAGE = "Edit target must be a user message"
CANNOT_RESOLVE_USER_MESSAGE = "Cannot resolve user message to regenerate from"


def conversation_response(conversation: Conversation) -> ConversationResponse:
    return ConversationResponse.model_validate(conversation)


def message_response(
    message: Message,
    *,
    conversation_public_id: uuid.UUID,
    run_public_id: uuid.UUID | None,
) -> MessageResponse:
    return MessageResponse(
        id=message.public_id,
        conversation_id=conversation_public_id,
        run_id=run_public_id,
        role=cast(Literal["user", "assistant"], message.role),
        content=message.content,
        reasoning=message.reasoning,
        metadata=message.metadata_,
        position=message.position,
        created_at=message.created_at,
    )


def run_response(
    run: Run,
    *,
    conversation_public_id: uuid.UUID,
    user_message_public_id: uuid.UUID,
) -> RunResponse:
    return RunResponse(
        id=run.public_id,
        conversation_id=conversation_public_id,
        user_message_id=user_message_public_id,
        status=cast(RunStatus, run.status),
        provider_name=run.provider_name,
        provider_model=run.provider_model,
        created_at=run.created_at,
    )


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
                Conversation.activated_at.is_not(None),
            )
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
        )
    ).all()
    return [conversation_response(conversation) for conversation in conversations]


async def get_conversation_detail(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
) -> ConversationDetailResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        public_id=conversation_public_id,
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
    run_public_ids = await _run_public_id_map(session, messages)
    return ConversationDetailResponse(
        **conversation_response(conversation).model_dump(),
        messages=[
            message_response(
                message,
                conversation_public_id=conversation.public_id,
                run_public_id=(
                    run_public_ids.get(message.run_id)
                    if message.run_id is not None
                    else None
                ),
            )
            for message in messages
        ],
    )


async def rename_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
    title: str,
) -> ConversationResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        public_id=conversation_public_id,
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
    conversation_public_id: uuid.UUID,
) -> CommandStatusResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        public_id=conversation_public_id,
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
    conversation_public_id: uuid.UUID,
    content: str,
    provider_name: str,
    provider_model: str,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        public_id=conversation_public_id,
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
        provider_options=provider_options,
        system_prompt_snapshot=system_prompt_snapshot,
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    conversation.updated_at = await get_database_now(session)
    await session.flush()

    # Notify worker(s) that a new run is queued. NOTIFY is delivered on COMMIT,
    # so it's safe to enqueue here — the API handler commits the transaction.
    await session.execute(
        text("SELECT pg_notify('runs_queued', :payload)"),
        {"payload": str(run.id)},
    )

    return SendMessageResponse(
        message=message_response(
            message,
            conversation_public_id=conversation.public_id,
            run_public_id=run.public_id,
        ),
        run=run_response(
            run,
            conversation_public_id=conversation.public_id,
            user_message_public_id=message.public_id,
        ),
    )


async def edit_user_message_and_regenerate(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
    message_public_id: uuid.UUID,
    new_content: str,
    provider_name: str,
    provider_model: str,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        public_id=conversation_public_id,
    )
    target = await _get_owned_unarchived_message_by_public_id(
        session,
        conversation_id=conversation.id,
        message_public_id=message_public_id,
    )
    if target.role != "user":
        raise AppError(status.HTTP_409_CONFLICT, EDIT_TARGET_NOT_USER_MESSAGE)

    await ensure_no_active_run(session, conversation_id=conversation.id)
    await _archive_messages_at_or_after_position(
        session,
        conversation_id=conversation.id,
        position=target.position,
    )

    next_position = await get_next_message_position(session, conversation_id=conversation.id)
    new_message = Message(
        conversation_id=conversation.id,
        role="user",
        content=new_content,
        position=next_position,
    )
    session.add(new_message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=new_message.id,
        status="queued",
        provider_name=provider_name,
        provider_model=provider_model,
        provider_options=provider_options,
        system_prompt_snapshot=system_prompt_snapshot,
    )
    session.add(run)
    await session.flush()

    new_message.run_id = run.id
    conversation.updated_at = await get_database_now(session)
    await session.flush()

    await session.execute(
        text("SELECT pg_notify('runs_queued', :payload)"),
        {"payload": str(run.id)},
    )

    return SendMessageResponse(
        message=message_response(
            new_message,
            conversation_public_id=conversation.public_id,
            run_public_id=run.public_id,
        ),
        run=run_response(
            run,
            conversation_public_id=conversation.public_id,
            user_message_public_id=new_message.public_id,
        ),
    )


async def regenerate_from_message(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
    message_public_id: uuid.UUID,
    provider_name: str,
    provider_model: str,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        public_id=conversation_public_id,
    )
    target = await _get_owned_unarchived_message_by_public_id(
        session,
        conversation_id=conversation.id,
        message_public_id=message_public_id,
    )

    if target.role == "assistant":
        if target.run_id is None:
            raise AppError(status.HTTP_409_CONFLICT, CANNOT_RESOLVE_USER_MESSAGE)
        target_run = await session.get(Run, target.run_id)
        if target_run is None:
            raise AppError(status.HTTP_409_CONFLICT, CANNOT_RESOLVE_USER_MESSAGE)
        anchor = await _get_owned_unarchived_message_for_update(
            session,
            conversation_id=conversation.id,
            message_id=target_run.user_message_id,
        )
        if anchor.role != "user":
            raise AppError(status.HTTP_409_CONFLICT, CANNOT_RESOLVE_USER_MESSAGE)
    else:
        anchor = target

    await ensure_no_active_run(session, conversation_id=conversation.id)
    await _archive_messages_after_position(
        session,
        conversation_id=conversation.id,
        position=anchor.position,
    )

    run = Run(
        conversation_id=conversation.id,
        user_message_id=anchor.id,
        status="queued",
        provider_name=provider_name,
        provider_model=provider_model,
        provider_options=provider_options,
        system_prompt_snapshot=system_prompt_snapshot,
    )
    session.add(run)
    await session.flush()

    conversation.updated_at = await get_database_now(session)
    await session.flush()

    await session.execute(
        text("SELECT pg_notify('runs_queued', :payload)"),
        {"payload": str(run.id)},
    )

    anchor_run_public_id: uuid.UUID | None = None
    if anchor.run_id is not None:
        anchor_run = await session.get(Run, anchor.run_id)
        anchor_run_public_id = anchor_run.public_id if anchor_run is not None else None

    return SendMessageResponse(
        message=message_response(
            anchor,
            conversation_public_id=conversation.public_id,
            run_public_id=anchor_run_public_id,
        ),
        run=run_response(
            run,
            conversation_public_id=conversation.public_id,
            user_message_public_id=anchor.public_id,
        ),
    )


async def get_owned_visible_conversation(
    session: AsyncSession,
    *,
    user: User,
    public_id: uuid.UUID,
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation).where(
            Conversation.public_id == public_id,
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
    public_id: uuid.UUID,
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation)
        .where(
            Conversation.public_id == public_id,
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


async def ensure_conversation_activated(
    session: AsyncSession,
    *,
    conversation_id: int,
) -> None:
    await session.execute(
        update(Conversation)
        .where(
            Conversation.id == conversation_id,
            Conversation.activated_at.is_(None),
        )
        .values(
            activated_at=func.now(),
            updated_at=func.now(),
        )
    )


async def materialize_assistant_message(
    session: AsyncSession,
    *,
    run_id: int,
    content: str,
    reasoning: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Message:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    next_position = await get_next_message_position(
        session,
        conversation_id=run.conversation_id,
    )
    message = Message(
        conversation_id=run.conversation_id,
        run_id=run.id,
        role="assistant",
        content=content,
        reasoning=reasoning,
        metadata_=metadata,
        position=next_position,
    )
    session.add(message)
    await session.flush()

    await ensure_conversation_activated(session, conversation_id=run.conversation_id)

    conversation = await session.get(Conversation, run.conversation_id)
    if conversation is not None:
        conversation.updated_at = await get_database_now(session)
        await session.flush()
    return message


async def _archive_messages_at_or_after_position(
    session: AsyncSession,
    *,
    conversation_id: int,
    position: int,
) -> None:
    now = await get_database_now(session)
    await session.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.position >= position,
            Message.archived_at.is_(None),
        )
        .values(archived_at=now)
    )


async def _archive_messages_after_position(
    session: AsyncSession,
    *,
    conversation_id: int,
    position: int,
) -> None:
    now = await get_database_now(session)
    await session.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.position > position,
            Message.archived_at.is_(None),
        )
        .values(archived_at=now)
    )


async def _get_owned_unarchived_message_for_update(
    session: AsyncSession,
    *,
    conversation_id: int,
    message_id: int,
) -> Message:
    message = await session.scalar(
        select(Message)
        .where(
            Message.id == message_id,
            Message.conversation_id == conversation_id,
            Message.archived_at.is_(None),
        )
        .with_for_update()
    )
    if message is None:
        raise AppError(status.HTTP_404_NOT_FOUND, MESSAGE_NOT_FOUND_MESSAGE)
    return message


async def _get_owned_unarchived_message_by_public_id(
    session: AsyncSession,
    *,
    conversation_id: int,
    message_public_id: uuid.UUID,
) -> Message:
    message = await session.scalar(
        select(Message)
        .where(
            Message.public_id == message_public_id,
            Message.conversation_id == conversation_id,
            Message.archived_at.is_(None),
        )
        .with_for_update()
    )
    if message is None:
        raise AppError(status.HTTP_404_NOT_FOUND, MESSAGE_NOT_FOUND_MESSAGE)
    return message


async def _run_public_id_map(
    session: AsyncSession,
    messages: Sequence[Message],
) -> dict[int, uuid.UUID]:
    """Map internal run ids referenced by messages to their public ids.

    Runs in a single query so conversation detail avoids a per-message lookup.
    """
    run_ids = {message.run_id for message in messages if message.run_id is not None}
    if not run_ids:
        return {}
    rows = await session.execute(select(Run.id, Run.public_id).where(Run.id.in_(run_ids)))
    return {row.id: row.public_id for row in rows}


def normalize_optional_title(title: str | None) -> str | None:
    if title is None:
        return None
    normalized = title.strip()
    return normalized or None
