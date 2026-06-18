import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import status
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.core.errors import AppError
from app.models.conversation import Conversation, Message, ShareLink
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.shares import (
    PublicShareResponse,
    SharedMessage,
    ShareLinkResponse,
)
from app.services.conversations.service import (
    get_database_now,
    get_owned_visible_conversation,
    get_owned_visible_conversation_for_update,
)

SHARE_NOT_FOUND_MESSAGE = "Share not found"
ACTIVE_SHARE_EXISTS_MESSAGE = "Active share already exists"
# 32 bytes of entropy -> 43-char urlsafe token (~256 bits, non-enumerable).
_TOKEN_NBYTES = 32


def _active_share_filter(now: datetime) -> ColumnElement[bool]:
    """A share is active when it is neither revoked nor past its expiry."""
    return and_(
        ShareLink.revoked_at.is_(None),
        or_(ShareLink.expires_at.is_(None), ShareLink.expires_at > now),
    )


def share_link_response(share: ShareLink) -> ShareLinkResponse:
    return ShareLinkResponse(
        token=share.token,
        expires_at=share.expires_at,
        revoked_at=share.revoked_at,
        created_at=share.created_at,
    )


def _build_snapshot(conversation: Conversation, messages: list[Message]) -> dict[str, Any]:
    """Freeze the conversation into a snapshot dict.

    Only role/content/reasoning/sources are kept — never internal ids, run ids,
    positions, timestamps, or user identity.
    """
    return {
        "title": conversation.title,
        "messages": [
            {
                "role": message.role,
                "content": message.content,
                "reasoning": message.reasoning,
                "sources": (message.metadata_ or {}).get("sources", []),
            }
            for message in messages
        ],
    }


async def create_share(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: UUID,
    expires_in_days: int | None,
) -> ShareLinkResponse:
    # Lock the conversation row so concurrent creates serialize: the
    # "no active share" check below and the insert are then atomic, enforcing
    # at most one active link per conversation without a DB-level constraint
    # (a partial unique index can't express the time-dependent expiry).
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        public_id=conversation_public_id,
    )

    now = await get_database_now(session)
    existing_active = await session.scalar(
        select(ShareLink.id).where(
            ShareLink.conversation_id == conversation.id,
            _active_share_filter(now),
        )
    )
    if existing_active is not None:
        raise AppError(status.HTTP_409_CONFLICT, ACTIVE_SHARE_EXISTS_MESSAGE)

    # Same filter as get_conversation_detail: unarchived, position-ordered. Using
    # the live (non-archived) messages is what makes the snapshot edit-proof —
    # later edits archive rows, they never mutate the frozen copy.
    messages = list(
        (
            await session.scalars(
                select(Message)
                .where(
                    Message.conversation_id == conversation.id,
                    Message.archived_at.is_(None),
                )
                .order_by(Message.position.asc())
            )
        ).all()
    )

    expires_at = now + timedelta(days=expires_in_days) if expires_in_days is not None else None

    share = ShareLink(
        token=secrets.token_urlsafe(_TOKEN_NBYTES),
        conversation_id=conversation.id,
        created_by=user.id,
        snapshot=_build_snapshot(conversation, messages),
        expires_at=expires_at,
    )
    session.add(share)
    await session.flush()
    await session.refresh(share)
    return share_link_response(share)


async def list_shares(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: UUID,
) -> list[ShareLinkResponse]:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        public_id=conversation_public_id,
    )
    # Only active links are surfaced; revoked/expired rows stay in the table for
    # audit but are never shown. With the create-time guard there is at most one.
    now = await get_database_now(session)
    shares = (
        await session.scalars(
            select(ShareLink)
            .where(
                ShareLink.conversation_id == conversation.id,
                _active_share_filter(now),
            )
            .order_by(ShareLink.created_at.desc(), ShareLink.id.desc())
        )
    ).all()
    return [share_link_response(share) for share in shares]


async def revoke_share(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: UUID,
    token: str,
) -> CommandStatusResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        public_id=conversation_public_id,
    )
    share = await session.scalar(
        select(ShareLink)
        .where(
            ShareLink.token == token,
            ShareLink.conversation_id == conversation.id,
        )
        .with_for_update()
    )
    if share is None:
        raise AppError(status.HTTP_404_NOT_FOUND, SHARE_NOT_FOUND_MESSAGE)
    # Idempotent: revoking an already-revoked link is a no-op success.
    if share.revoked_at is None:
        share.revoked_at = await get_database_now(session)
        await session.flush()
    return CommandStatusResponse()


async def get_public_share(
    session: AsyncSession,
    *,
    token: str,
) -> PublicShareResponse:
    """Anonymous read. The ONE path that intentionally bypasses ownership.

    Unknown / revoked / expired all collapse to a single 404 so the caller
    cannot distinguish reasons (no probing).
    """
    share = await session.scalar(select(ShareLink).where(ShareLink.token == token))
    if share is None or share.revoked_at is not None:
        raise AppError(status.HTTP_404_NOT_FOUND, SHARE_NOT_FOUND_MESSAGE)
    if share.expires_at is not None:
        now = await get_database_now(session)
        if share.expires_at <= now:
            raise AppError(status.HTTP_404_NOT_FOUND, SHARE_NOT_FOUND_MESSAGE)

    snapshot = share.snapshot or {}
    return PublicShareResponse(
        title=snapshot.get("title"),
        messages=[SharedMessage.model_validate(item) for item in snapshot.get("messages", [])],
        created_at=share.created_at,
    )
