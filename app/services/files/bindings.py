from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import (
    AttachmentNoticeBlock,
    ContentBlock,
    DocumentBlock,
    TextBlock,
)
from app.agent.messages import (
    Message as AgentMessage,
)
from app.core.config import Settings
from app.core.errors import AppError
from app.models.conversation import Message
from app.models.files import FileAsset, FilePurpose, MessageAttachment
from app.models.user import User
from app.services.agents.context import estimate_message_tokens

ATTACHMENT_INVALID = "One or more attachments are unavailable"
ATTACHMENT_LIMIT = "A message can include at most five attachments"
ATTACHMENT_SIZE_LIMIT = "Attachments exceed the per-message size limit"
EMPTY_MODEL_INPUT = "Enter a message or attach a readable document"
TARGET_TURN_TOO_LARGE = "Attachments exceed the model context budget"


@dataclass(frozen=True)
class AttachmentPlan:
    files: tuple[FileAsset, ...]
    blocks: tuple[ContentBlock, ...]


async def current_attachment_files(
    session: AsyncSession,
    *,
    message_id: int,
) -> list[FileAsset]:
    return list(
        (
            await session.scalars(
                select(FileAsset)
                .join(MessageAttachment, MessageAttachment.file_id == FileAsset.id)
                .where(MessageAttachment.message_id == message_id)
                .order_by(MessageAttachment.position)
            )
        ).all()
    )


async def prepare_attachment_plan(
    session: AsyncSession,
    *,
    user: User,
    content: str,
    attachment_ids: list[UUID],
    allowed_bound_file_ids: set[int] | None,
    settings: Settings,
    count_tokens: Callable[[str], int],
    now: datetime | None = None,
) -> AttachmentPlan:
    moment = now or datetime.now(UTC)
    if len(attachment_ids) > settings.files_max_attachments_per_message:
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, ATTACHMENT_LIMIT)
    if len(attachment_ids) != len(set(attachment_ids)):
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, "Attachment IDs must be unique")

    rows = list(
        (
            await session.scalars(
                select(FileAsset)
                .where(FileAsset.public_id.in_(attachment_ids))
                .with_for_update()
            )
        ).all()
    )
    by_public_id = {file.public_id: file for file in rows}
    if len(rows) != len(attachment_ids):
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, ATTACHMENT_INVALID)
    files = [by_public_id[public_id] for public_id in attachment_ids]
    allowed = allowed_bound_file_ids or set()
    for file in files:
        unbound_valid = (
            file.bound_at is None
            and file.unbound_expires_at is not None
            and file.unbound_expires_at > moment
        )
        inherited_valid = file.id in allowed
        if (
            file.user_id != user.id
            or file.purpose != FilePurpose.MESSAGE_ATTACHMENT
            or file.deletion_started_at is not None
            or not (unbound_valid or inherited_valid)
        ):
            raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, ATTACHMENT_INVALID)
    if sum(file.size_bytes for file in files) > settings.files_max_message_bytes:
        raise AppError(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, ATTACHMENT_SIZE_LIMIT)
    if not content.strip() and not any(file.model_consumable for file in files):
        raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, EMPTY_MODEL_INPUT)

    blocks: list[ContentBlock] = []
    if content:
        blocks.append(TextBlock(content))
    for file in files:
        if file.model_consumable:
            if file.document_text is None or not file.document_text:
                raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, ATTACHMENT_INVALID)
            blocks.append(
                DocumentBlock(
                    file_id=str(file.public_id),
                    filename=file.original_filename,
                    media_type=file.media_type,
                    text=file.document_text,
                    sha256=file.sha256 or "unknown",
                    extractor_version=file.extractor_version or "legacy",
                    warnings=tuple(file.warnings or []),
                    summary=dict(file.summary_metadata or {}),
                )
            )
        else:
            blocks.append(
                AttachmentNoticeBlock(
                    file_id=str(file.public_id),
                    filename=file.original_filename,
                    media_type=file.media_type,
                )
            )
    message = AgentMessage(role="user", blocks=blocks)
    target_limit = min(
        settings.attachment_target_turn_tokens,
        settings.context_budget_tokens // 2,
    )
    if estimate_message_tokens(message, count_tokens=count_tokens) > target_limit:
        raise AppError(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, TARGET_TURN_TOO_LARGE)
    return AttachmentPlan(files=tuple(files), blocks=tuple(blocks))


async def bind_attachment_plan(
    session: AsyncSession,
    *,
    message: Message,
    plan: AttachmentPlan,
    now: datetime | None = None,
) -> None:
    moment = now or datetime.now(UTC)
    for position, file in enumerate(plan.files):
        session.add(
            MessageAttachment(
                message_id=message.id,
                file_id=file.id,
                position=position,
                name=file.original_filename,
                media_type=file.media_type,
                size_bytes=file.size_bytes,
                warnings=list(file.warnings or []),
            )
        )
        if file.bound_at is None:
            file.bound_at = moment
            file.unbound_expires_at = None
            file.source_message_id = message.id
        file.detached_at = None
    await session.flush()


async def refresh_detached_state(
    session: AsyncSession,
    *,
    file_ids: set[int],
    now: datetime | None = None,
) -> None:
    moment = now or datetime.now(UTC)
    for file_id in file_ids:
        file = await session.scalar(
            select(FileAsset).where(FileAsset.id == file_id).with_for_update()
        )
        if file is None or file.deletion_started_at is not None:
            continue
        current_reference = await session.scalar(
            select(MessageAttachment.id)
            .join(Message, Message.id == MessageAttachment.message_id)
            .where(
                MessageAttachment.file_id == file_id,
                Message.archived_at.is_(None),
            )
            .limit(1)
        )
        file.detached_at = None if current_reference is not None else moment
    await session.flush()
