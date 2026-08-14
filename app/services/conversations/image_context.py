from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import AttachmentNoticeBlock, ContentBlock, ImageBlock
from app.models.conversation import Message
from app.models.run import RunProviderMessage
from app.services.runs.transcript import transcript_message_from_row

ImageContextState = Literal["none", "vision_required", "legacy_upgrade_required"]


@dataclass(frozen=True)
class MessageImageFacts:
    message_id: int
    message_public_id: UUID
    position: int
    vision_file_ids: frozenset[str]
    legacy_file_ids: frozenset[str]


@dataclass(frozen=True)
class ImageContextFacts:
    messages: tuple[MessageImageFacts, ...] = ()

    @property
    def has_vision(self) -> bool:
        return any(message.vision_file_ids for message in self.messages)

    @property
    def has_legacy(self) -> bool:
        return any(message.legacy_file_ids for message in self.messages)

    @property
    def state(self) -> ImageContextState:
        if self.has_vision:
            return "vision_required"
        if self.has_legacy:
            return "legacy_upgrade_required"
        return "none"

    @property
    def legacy_message_id(self) -> UUID | None:
        if self.state != "legacy_upgrade_required":
            return None
        anchor = next(message for message in self.messages if message.legacy_file_ids)
        return anchor.message_public_id

    def for_message(self, message_id: int) -> MessageImageFacts | None:
        return next(
            (message for message in self.messages if message.message_id == message_id),
            None,
        )

    def before(self, position: int) -> ImageContextFacts:
        return ImageContextFacts(
            tuple(message for message in self.messages if message.position < position)
        )

    def with_candidate(
        self,
        *,
        message_id: int,
        message_public_id: UUID,
        position: int,
        blocks: tuple[ContentBlock, ...],
    ) -> ImageContextFacts:
        return ImageContextFacts(
            (
                *self.messages,
                _message_facts(
                    message_id=message_id,
                    message_public_id=message_public_id,
                    position=position,
                    blocks=blocks,
                ),
            )
        )


async def derive_image_context(
    session: AsyncSession,
    *,
    conversation_id: int,
) -> ImageContextFacts:
    """Derive current image truth from unarchived messages and their current runs."""

    messages = list(
        (
            await session.scalars(
                select(Message)
                .where(
                    Message.conversation_id == conversation_id,
                    Message.role == "user",
                    Message.archived_at.is_(None),
                )
                .order_by(Message.position.asc())
            )
        ).all()
    )
    run_ids = [message.run_id for message in messages if message.run_id is not None]
    transcript_by_message: dict[tuple[int, int], RunProviderMessage] = {}
    if run_ids:
        transcript_rows = list(
            (
                await session.scalars(
                    select(RunProviderMessage).where(
                        RunProviderMessage.run_id.in_(run_ids),
                        RunProviderMessage.message_id.is_not(None),
                        RunProviderMessage.role == "user",
                    )
                )
            ).all()
        )
        transcript_by_message = {
            (row.run_id, row.message_id): row
            for row in transcript_rows
            if row.message_id is not None
        }

    facts: list[MessageImageFacts] = []
    for message in messages:
        row = (
            transcript_by_message.get((message.run_id, message.id))
            if message.run_id is not None
            else None
        )
        blocks = transcript_message_from_row(row).blocks if row is not None else []
        facts.append(
            _message_facts(
                message_id=message.id,
                message_public_id=message.public_id,
                position=message.position,
                blocks=blocks,
            )
        )
    return ImageContextFacts(tuple(facts))


def _message_facts(
    *,
    message_id: int,
    message_public_id: UUID,
    position: int,
    blocks: list[ContentBlock] | tuple[ContentBlock, ...],
) -> MessageImageFacts:
    return MessageImageFacts(
        message_id=message_id,
        message_public_id=message_public_id,
        position=position,
        vision_file_ids=frozenset(
            block.file_id for block in blocks if isinstance(block, ImageBlock)
        ),
        legacy_file_ids=frozenset(
            block.file_id
            for block in blocks
            if isinstance(block, AttachmentNoticeBlock)
            and block.media_type.casefold().startswith("image/")
        ),
    )
