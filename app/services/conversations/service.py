import uuid
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from typing import Any, Literal, cast

from fastapi import status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import Message as AgentMessage
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationCreateWithMessageResponse,
    ConversationDetailResponse,
    ConversationResponse,
    ImageContextResponse,
    MessageResponse,
    RunResponse,
    SendMessageResponse,
)
from app.schemas.files import MessageAttachmentResponse
from app.schemas.runs import RunStatus
from app.services.agents.catalog import available_chat_models
from app.services.conversations.image_context import (
    ImageContextFacts,
    MessageImageFacts,
    derive_image_context,
)
from app.services.files.bindings import (
    ATTACHMENT_INVALID,
    bind_attachment_plan,
    current_attachment_files,
    prepare_attachment_plan,
    refresh_detached_state,
)
from app.services.files.service import attachment_responses
from app.services.runs.transcript import append_transcript_message

CONVERSATION_NOT_FOUND_MESSAGE = "Conversation not found"
ACTIVE_RUN_STATUSES = ("queued", "started", "streaming", "cancelling")
ACTIVE_RUN_EXISTS_MESSAGE = "Active run already exists"
MESSAGE_NOT_FOUND_MESSAGE = "Message not found"
EDIT_TARGET_NOT_USER_MESSAGE = "Edit target must be a user message"
CANNOT_RESOLVE_USER_MESSAGE = "Cannot resolve user message to regenerate from"
VISION_MODEL_REQUIRED_MESSAGE = "This conversation requires a vision-capable model"
VISION_MODEL_REQUIRED_CODE = "VISION_MODEL_REQUIRED"
LEGACY_IMAGE_CONTEXT_MESSAGE = (
    "Upgrade the earliest display-only image message before using a vision model"
)
LEGACY_IMAGE_CONTEXT_CODE = "LEGACY_IMAGE_CONTEXT"


def _run_provider_options(
    provider_options: dict[str, Any] | None,
    *,
    image_token_reserve: int | None,
) -> dict[str, Any]:
    """Persist the model's admission reserve as part of the run snapshot."""

    options = dict(provider_options or {})
    options["image_token_reserve"] = image_token_reserve
    return options


def conversation_response(conversation: Conversation) -> ConversationResponse:
    return ConversationResponse.model_validate(conversation)


def message_response(
    message: Message,
    *,
    conversation_public_id: uuid.UUID,
    run_public_id: uuid.UUID | None,
    attachments: list[MessageAttachmentResponse] | None = None,
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
        attachments=attachments or [],
    )


async def get_internal_run_id(
    session: AsyncSession,
    *,
    run_public_id: uuid.UUID,
) -> int:
    run_id = await session.scalar(select(Run.id).where(Run.public_id == run_public_id))
    if run_id is None:
        raise LookupError(f"Run {run_public_id} not found")
    return run_id


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


async def _lock_active_user(session: AsyncSession, *, user_id: int) -> User:
    is_active = await session.scalar(
        select(User.is_active)
        .where(User.id == user_id)
        .with_for_update(read=True)
    )
    if is_active is not True:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    owner = await session.get(User, user_id)
    if owner is None:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    return owner


async def create_conversation(
    session: AsyncSession,
    *,
    user: User,
    title: str | None,
) -> ConversationResponse:
    conversation = await _create_conversation_model(session, user=user, title=title)
    return conversation_response(conversation)


async def _create_conversation_model(
    session: AsyncSession,
    *,
    user: User,
    title: str | None,
) -> Conversation:
    conversation = Conversation(user_id=user.id, title=normalize_optional_title(title))
    session.add(conversation)
    await session.flush()
    return conversation


async def list_conversations(
    session: AsyncSession,
    *,
    user: User,
    limit: int | None = None,
    skip: int = 0,
) -> list[ConversationResponse]:
    statement = (
        select(Conversation)
        .where(
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
            Conversation.activated_at.is_not(None),
        )
        .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
        .offset(skip)
    )
    if limit is not None:
        statement = statement.limit(limit)

    conversations = (
        await session.scalars(statement)
    ).all()
    return [conversation_response(conversation) for conversation in conversations]


async def get_conversation_detail(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
    settings: Settings | None = None,
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
    attachment_map = await attachment_responses(
        session,
        message_ids=[message.id for message in messages],
    )
    image_context = await _image_context_response(
        session,
        conversation=conversation,
        settings=settings or get_settings(),
    )
    return ConversationDetailResponse(
        **conversation_response(conversation).model_dump(),
        image_context=image_context,
        messages=[
            message_response(
                message,
                conversation_public_id=conversation.public_id,
                run_public_id=(
                    run_public_ids.get(message.run_id)
                    if message.run_id is not None
                    else None
                ),
                attachments=attachment_map.get(message.id, []),
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
    conversation.deletion_due_at = now + timedelta(
        seconds=get_settings().conversation_deletion_retention_seconds
    )
    conversation.updated_at = now
    await session.flush()
    return CommandStatusResponse()


async def list_deleted_conversations(
    session: AsyncSession,
    *,
    user: User,
) -> list[ConversationResponse]:
    rows = list(
        (
            await session.scalars(
                select(Conversation)
                .where(
                    Conversation.user_id == user.id,
                    Conversation.deleted_at.is_not(None),
                    Conversation.deletion_due_at.is_not(None),
                )
                .order_by(Conversation.deletion_due_at.asc())
            )
        ).all()
    )
    return [conversation_response(row) for row in rows]


async def restore_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
) -> ConversationResponse:
    conversation = await session.scalar(
        select(Conversation)
        .where(
            Conversation.public_id == conversation_public_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_not(None),
        )
        .with_for_update()
    )
    if conversation is None:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    now = await get_database_now(session)
    if conversation.deletion_due_at is None or conversation.deletion_due_at <= now:
        raise AppError(status.HTTP_410_GONE, "Conversation can no longer be restored")
    conversation.deleted_at = None
    conversation.deletion_due_at = None
    conversation.updated_at = now
    await session.flush()
    return conversation_response(conversation)


async def submit_user_message(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
    content: str,
    provider_name: str,
    provider_model: str,
    supports_image_input: bool | None = None,
    image_token_reserve: int | None = None,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
    attachment_ids: list[uuid.UUID] | None = None,
    settings: Settings | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> SendMessageResponse:
    active_user = await _lock_active_user(session, user_id=user.id)
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        public_id=conversation_public_id,
    )
    return await _submit_user_message_to_conversation(
        session,
        conversation=conversation,
        user=active_user,
        content=content,
        provider_name=provider_name,
        provider_model=provider_model,
        supports_image_input=supports_image_input,
        image_token_reserve=image_token_reserve,
        provider_options=provider_options,
        system_prompt_snapshot=system_prompt_snapshot,
        attachment_ids=attachment_ids or [],
        settings=settings or get_settings(),
        count_tokens=count_tokens or len,
    )


async def create_conversation_with_message(
    session: AsyncSession,
    *,
    user: User,
    title: str | None,
    content: str,
    provider_name: str,
    provider_model: str,
    supports_image_input: bool | None = None,
    image_token_reserve: int | None = None,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
    attachment_ids: list[uuid.UUID] | None = None,
    settings: Settings | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> ConversationCreateWithMessageResponse:
    active_user = await _lock_active_user(session, user_id=user.id)
    conversation = await _create_conversation_model(session, user=user, title=title)
    submitted = await _submit_user_message_to_conversation(
        session,
        conversation=conversation,
        user=active_user,
        content=content,
        provider_name=provider_name,
        provider_model=provider_model,
        supports_image_input=supports_image_input,
        image_token_reserve=image_token_reserve,
        provider_options=provider_options,
        system_prompt_snapshot=system_prompt_snapshot,
        attachment_ids=attachment_ids or [],
        settings=settings or get_settings(),
        count_tokens=count_tokens or len,
    )
    return ConversationCreateWithMessageResponse(
        conversation=conversation_response(conversation),
        message=submitted.message,
        run=submitted.run,
        image_context=submitted.image_context,
    )


async def _submit_user_message_to_conversation(
    session: AsyncSession,
    *,
    conversation: Conversation,
    user: User,
    content: str,
    provider_name: str,
    provider_model: str,
    supports_image_input: bool | None = None,
    image_token_reserve: int | None = None,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
    attachment_ids: list[uuid.UUID] | None = None,
    settings: Settings | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> SendMessageResponse:
    await ensure_no_active_run(session, conversation_id=conversation.id)
    current_context = await derive_image_context(
        session,
        conversation_id=conversation.id,
    )
    if supports_image_input is not None:
        _validate_existing_image_context(
            current_context,
            supports_image_input=supports_image_input,
        )
    next_position = await get_next_message_position(session, conversation_id=conversation.id)

    resolved_settings = settings or get_settings()
    token_counter = count_tokens or len
    plan = await prepare_attachment_plan(
        session,
        user=user,
        content=content,
        attachment_ids=attachment_ids or [],
        allowed_bound_file_ids=None,
        settings=resolved_settings,
        count_tokens=token_counter,
        supports_image_input=supports_image_input,
        image_token_reserve=image_token_reserve,
        legacy_notice_file_ids=set(),
    )

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
        provider_options=_run_provider_options(
            provider_options,
            image_token_reserve=image_token_reserve,
        ),
        system_prompt_snapshot=system_prompt_snapshot,
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    await bind_attachment_plan(session, message=message, plan=plan)
    await append_transcript_message(
        session,
        run_id=run.id,
        message=AgentMessage(role="user", blocks=list(plan.blocks)),
        message_id=message.id,
        count_tokens=token_counter,
    )
    conversation.updated_at = await get_database_now(session)
    await session.flush()

    attachment_map = await attachment_responses(session, message_ids=[message.id])
    image_context = await _image_context_response(
        session,
        conversation=conversation,
        settings=resolved_settings,
    )

    return SendMessageResponse(
        message=message_response(
            message,
            conversation_public_id=conversation.public_id,
            run_public_id=run.public_id,
            attachments=attachment_map.get(message.id, []),
        ),
        run=run_response(
            run,
            conversation_public_id=conversation.public_id,
            user_message_public_id=message.public_id,
        ),
        image_context=image_context,
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
    supports_image_input: bool | None = None,
    image_token_reserve: int | None = None,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
    attachment_ids: list[uuid.UUID] | None = None,
    settings: Settings | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> SendMessageResponse:
    active_user = await _lock_active_user(session, user_id=user.id)
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
    inherited_files = await current_attachment_files(session, message_id=target.id)
    selected_ids = (
        [file.public_id for file in inherited_files]
        if attachment_ids is None
        else attachment_ids
    )
    resolved_settings = settings or get_settings()
    token_counter = count_tokens or len
    current_context = await derive_image_context(
        session,
        conversation_id=conversation.id,
    )
    target_image_facts = current_context.for_message(target.id)
    selected_public_ids = {str(public_id) for public_id in selected_ids}
    if attachment_ids is None:
        _validate_snapshot_attachments(target_image_facts, selected_public_ids)
    if supports_image_input is not None:
        _validate_existing_image_context(
            current_context.before(target.position),
            supports_image_input=supports_image_input,
        )
        if (
            not supports_image_input
            and target_image_facts is not None
            and bool(target_image_facts.vision_file_ids & selected_public_ids)
        ):
            _raise_vision_model_required()
    legacy_notice_file_ids = {
        file.id
        for file in inherited_files
        if target_image_facts is not None
        and str(file.public_id) in target_image_facts.legacy_file_ids
    }
    plan = await prepare_attachment_plan(
        session,
        user=active_user,
        content=new_content,
        attachment_ids=selected_ids,
        allowed_bound_file_ids={file.id for file in inherited_files},
        settings=resolved_settings,
        count_tokens=token_counter,
        supports_image_input=supports_image_input,
        image_token_reserve=image_token_reserve,
        legacy_notice_file_ids=legacy_notice_file_ids,
    )
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
        provider_options=_run_provider_options(
            provider_options,
            image_token_reserve=image_token_reserve,
        ),
        system_prompt_snapshot=system_prompt_snapshot,
    )
    session.add(run)
    await session.flush()

    new_message.run_id = run.id
    await bind_attachment_plan(session, message=new_message, plan=plan)
    await append_transcript_message(
        session,
        run_id=run.id,
        message=AgentMessage(role="user", blocks=list(plan.blocks)),
        message_id=new_message.id,
        count_tokens=token_counter,
    )
    await refresh_detached_state(
        session,
        file_ids={file.id for file in inherited_files} | {file.id for file in plan.files},
    )
    conversation.updated_at = await get_database_now(session)
    await session.flush()

    attachment_map = await attachment_responses(session, message_ids=[new_message.id])
    image_context = await _image_context_response(
        session,
        conversation=conversation,
        settings=resolved_settings,
    )

    return SendMessageResponse(
        message=message_response(
            new_message,
            conversation_public_id=conversation.public_id,
            run_public_id=run.public_id,
            attachments=attachment_map.get(new_message.id, []),
        ),
        run=run_response(
            run,
            conversation_public_id=conversation.public_id,
            user_message_public_id=new_message.public_id,
        ),
        image_context=image_context,
    )


async def regenerate_from_message(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: uuid.UUID,
    message_public_id: uuid.UUID,
    provider_name: str,
    provider_model: str,
    supports_image_input: bool | None = None,
    image_token_reserve: int | None = None,
    provider_options: dict[str, Any] | None = None,
    system_prompt_snapshot: str | None = None,
    settings: Settings | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> SendMessageResponse:
    active_user = await _lock_active_user(session, user_id=user.id)
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
    attached_files = await current_attachment_files(session, message_id=anchor.id)
    resolved_settings = settings or get_settings()
    token_counter = count_tokens or len
    current_context = await derive_image_context(
        session,
        conversation_id=conversation.id,
    )
    anchor_image_facts = current_context.for_message(anchor.id)
    selected_public_ids = {str(file.public_id) for file in attached_files}
    _validate_snapshot_attachments(anchor_image_facts, selected_public_ids)
    if supports_image_input is not None:
        _validate_existing_image_context(
            current_context.before(anchor.position),
            supports_image_input=supports_image_input,
        )
        if (
            not supports_image_input
            and anchor_image_facts is not None
            and anchor_image_facts.vision_file_ids
        ):
            _raise_vision_model_required()
    legacy_notice_file_ids = {
        file.id
        for file in attached_files
        if anchor_image_facts is not None
        and str(file.public_id) in anchor_image_facts.legacy_file_ids
    }
    plan = await prepare_attachment_plan(
        session,
        user=active_user,
        content=anchor.content,
        attachment_ids=[file.public_id for file in attached_files],
        allowed_bound_file_ids={file.id for file in attached_files},
        settings=resolved_settings,
        count_tokens=token_counter,
        supports_image_input=supports_image_input,
        image_token_reserve=image_token_reserve,
        legacy_notice_file_ids=legacy_notice_file_ids,
    )
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
        provider_options=_run_provider_options(
            provider_options,
            image_token_reserve=image_token_reserve,
        ),
        system_prompt_snapshot=system_prompt_snapshot,
    )
    session.add(run)
    await session.flush()

    anchor.run_id = run.id
    await append_transcript_message(
        session,
        run_id=run.id,
        message=AgentMessage(role="user", blocks=list(plan.blocks)),
        message_id=anchor.id,
        count_tokens=token_counter,
    )

    conversation.updated_at = await get_database_now(session)
    await session.flush()

    attachment_map = await attachment_responses(session, message_ids=[anchor.id])
    image_context = await _image_context_response(
        session,
        conversation=conversation,
        settings=resolved_settings,
    )

    return SendMessageResponse(
        message=message_response(
            anchor,
            conversation_public_id=conversation.public_id,
            run_public_id=run.public_id,
            attachments=attachment_map.get(anchor.id, []),
        ),
        run=run_response(
            run,
            conversation_public_id=conversation.public_id,
            user_message_public_id=anchor.public_id,
        ),
        image_context=image_context,
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


def _validate_existing_image_context(
    image_context: ImageContextFacts,
    *,
    supports_image_input: bool,
) -> None:
    if image_context.has_vision and not supports_image_input:
        _raise_vision_model_required()
    if image_context.has_legacy and supports_image_input:
        legacy_message_id = image_context.legacy_message_id
        raise AppError(
            status.HTTP_409_CONFLICT,
            LEGACY_IMAGE_CONTEXT_MESSAGE,
            code=LEGACY_IMAGE_CONTEXT_CODE,
            context=(
                {"legacy_message_id": str(legacy_message_id)}
                if legacy_message_id is not None
                else None
            ),
        )


def _validate_snapshot_attachments(
    facts: MessageImageFacts | None,
    selected_public_ids: set[str],
) -> None:
    """Fail closed when a current image transcript lost its file relation."""

    if facts is None:
        return
    expected = facts.vision_file_ids | facts.legacy_file_ids
    if not expected.issubset(selected_public_ids):
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, ATTACHMENT_INVALID)


def _raise_vision_model_required() -> None:
    raise AppError(
        status.HTTP_409_CONFLICT,
        VISION_MODEL_REQUIRED_MESSAGE,
        code=VISION_MODEL_REQUIRED_CODE,
    )


async def _image_context_response(
    session: AsyncSession,
    *,
    conversation: Conversation,
    settings: Settings,
) -> ImageContextResponse:
    facts = await derive_image_context(session, conversation_id=conversation.id)
    models = available_chat_models(settings)

    def compatible(model_index: int) -> bool:
        model = models[model_index]
        if facts.state == "vision_required":
            return model.supports_image_input
        if facts.state == "legacy_upgrade_required":
            return not model.supports_image_input
        return True

    model_indexes = {model.model: index for index, model in enumerate(models)}
    recent_models = list(
        (
            await session.scalars(
                select(Run.provider_model)
                .join(Message, Message.run_id == Run.id)
                .where(
                    Message.conversation_id == conversation.id,
                    Message.role == "user",
                    Message.archived_at.is_(None),
                )
                .order_by(Run.created_at.desc(), Run.id.desc())
            )
        ).all()
    )
    recommended_model = next(
        (
            model
            for model in recent_models
            if model in model_indexes and compatible(model_indexes[model])
        ),
        None,
    )
    return ImageContextResponse(
        state=facts.state,
        legacy_message_id=facts.legacy_message_id,
        recommended_model=recommended_model,
    )


def normalize_optional_title(title: str | None) -> str | None:
    if title is None:
        return None
    normalized = title.strip()
    return normalized or None
