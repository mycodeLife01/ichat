import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import status
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import Settings
from app.core.errors import AppError
from app.models.conversation import Conversation, Message, ShareLink
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.files import FileReadUrlResponse
from app.schemas.shares import (
    PublicShareResponse,
    SharedMessage,
    ShareLinkResponse,
    UserShareResponse,
)
from app.services.auth import rate_limit
from app.services.conversations.service import (
    get_database_now,
    get_owned_visible_conversation,
    get_owned_visible_conversation_for_update,
)
from app.services.files.protocols import FileStorage
from app.services.files.service import attachment_responses, issue_shared_attachment_read_url

SHARE_NOT_FOUND_MESSAGE = "Share not found"
ACTIVE_SHARE_EXISTS_MESSAGE = "Active share already exists"
ATTACHMENT_NOT_FOUND_MESSAGE = "Attachment was not found"
READ_RATE_MESSAGE = "Too many attachment requests. Please try again later."
READ_UNAVAILABLE_MESSAGE = "Attachment reads are temporarily unavailable"
# 32 bytes of entropy -> 43-char urlsafe token (~256 bits, non-enumerable).
_TOKEN_NBYTES = 32
# Only geometry is copied into a snapshot: it is what the public page needs to
# lay an image out, and it leaks nothing about derived document content.
_SNAPSHOT_STAT_KEYS = ("width", "height")


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


def _build_snapshot(
    conversation: Conversation,
    messages: list[Message],
    attachments: dict[int, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Freeze the conversation into a snapshot dict.

    Only role/content/reasoning/sources are kept — never internal ids, run ids,
    positions, timestamps, or user identity. Attachment entries additionally
    carry a ``file_id`` used server-side to sign reads; it is stripped from the
    public response by ``SharedAttachmentResponse``, which does not declare it.
    """
    return {
        "title": conversation.title,
        "messages": [
            {
                "role": message.role,
                "content": message.content,
                "reasoning": message.reasoning,
                "sources": (message.metadata_ or {}).get("sources", []),
                "attachments": attachments.get(message.id, []),
            }
            for message in messages
        ],
    }


def _snapshot_attachments(
    messages: list[Message],
    responses: dict[int, list[Any]],
) -> dict[int, list[dict[str, Any]]]:
    """Turn live attachment rows into frozen snapshot entries.

    ``ref`` is the share-scoped handle the public read route resolves. It is
    derived from the message's snapshot index and the attachment position, so it
    stays stable for the life of the snapshot and carries no internal id.
    """
    snapshot: dict[int, list[dict[str, Any]]] = {}
    for message_index, message in enumerate(messages):
        for attachment in responses.get(message.id, []):
            # A NULL file_id (reclaimed asset) surfaces as the zero UUID; such
            # an attachment stays a metadata-only placeholder with no read path.
            has_asset = attachment.id != UUID(int=0)
            entry: dict[str, Any] = {
                "name": attachment.name,
                "media_type": attachment.media_type,
                "size_bytes": attachment.size_bytes,
                "category": attachment.category,
                "warnings": list(attachment.warnings or []),
                "position": attachment.position,
                "model_input_kind": attachment.model_input_kind,
                "preview_available": attachment.preview_available and has_asset,
                "stats": {
                    key: value
                    for key, value in attachment.stats.items()
                    if key in _SNAPSHOT_STAT_KEYS
                },
            }
            if has_asset:
                entry["ref"] = f"{message_index}-{attachment.position}"
                entry["file_id"] = str(attachment.id)
            snapshot.setdefault(message.id, []).append(entry)
    return snapshot


async def create_share(
    session: AsyncSession,
    *,
    user: User,
    conversation_public_id: UUID,
    expires_in_days: int | None,
    confirm_attachment_privacy: bool = False,
) -> ShareLinkResponse:
    active_user_id = await session.scalar(
        select(User.id)
        .where(User.id == user.id, User.is_active.is_(True))
        .with_for_update(read=True)
    )
    if active_user_id is None:
        raise AppError(status.HTTP_404_NOT_FOUND, "Conversation not found")
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
    message_ids = [message.id for message in messages]
    # Reuse the live attachment projection so a snapshot inherits the same
    # category/geometry/preview facts the chat page renders from.
    attachment_projection = await attachment_responses(session, message_ids=message_ids)
    if attachment_projection and not confirm_attachment_privacy:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Confirm that assistant replies may contain information from attachments",
        )
    attachment_snapshot = _snapshot_attachments(messages, attachment_projection)

    expires_at = now + timedelta(days=expires_in_days) if expires_in_days is not None else None

    share = ShareLink(
        token=secrets.token_urlsafe(_TOKEN_NBYTES),
        conversation_id=conversation.id,
        created_by=user.id,
        snapshot=_build_snapshot(conversation, messages, attachment_snapshot),
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


async def list_user_shares(
    session: AsyncSession,
    *,
    user: User,
) -> list[UserShareResponse]:
    """List every active share created by the current user across conversations."""
    now = await get_database_now(session)
    rows = (
        await session.execute(
            select(ShareLink, Conversation)
            .join(Conversation, Conversation.id == ShareLink.conversation_id)
            .where(
                ShareLink.created_by == user.id,
                Conversation.user_id == user.id,
                Conversation.deleted_at.is_(None),
                _active_share_filter(now),
            )
            .order_by(ShareLink.created_at.desc(), ShareLink.id.desc())
        )
    ).all()
    return [
        UserShareResponse(
            **share_link_response(share).model_dump(),
            conversation_id=conversation.public_id,
            conversation_title=conversation.title,
        )
        for share, conversation in rows
    ]


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


def _token_digest(token: str) -> str:
    """Hash the token before it becomes a Redis key.

    The raw token is a bearer credential for the whole snapshot; keeping it out
    of the key space keeps it out of Redis dumps and slow-log output.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:32]


def _too_many_requests(retry_after_seconds: int) -> AppError:
    return AppError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        READ_RATE_MESSAGE,
        headers={"Retry-After": str(max(retry_after_seconds, 1))},
    )


async def guard_public_read_rate_limit(
    redis: Redis,
    *,
    token: str,
    role: str,
    client_ip: str,
    settings: Settings,
) -> None:
    """Throttle anonymous attachment reads on two dimensions.

    Must run before the token is resolved so that probing an unknown or revoked
    token also consumes budget. The IP window caps a crawler sweeping many
    leaked tokens; the per-token window caps how much one leaked link can drain.
    Redis being unavailable fails closed: this route hands out object URLs.
    """
    if role == "download":
        token_limit = settings.share_read_token_download_limit
        token_window = settings.share_read_token_download_window_seconds
    else:
        token_limit = settings.share_read_token_preview_limit
        token_window = settings.share_read_token_preview_window_seconds
    try:
        ip_result = await rate_limit.check_ip_rate_limit(
            redis,
            f"share:rate:read:ip:{client_ip}",
            limit=settings.share_read_ip_limit,
            window_seconds=settings.share_read_ip_window_seconds,
        )
        if not ip_result.allowed:
            raise _too_many_requests(ip_result.retry_after_seconds)
        token_result = await rate_limit.check_ip_rate_limit(
            redis,
            f"share:rate:read:{role}:token:{_token_digest(token)}",
            limit=token_limit,
            window_seconds=token_window,
        )
        if not token_result.allowed:
            raise _too_many_requests(token_result.retry_after_seconds)
    except AppError:
        raise
    except Exception:
        logger.warning("Redis unavailable during share attachment read guard; failing closed")
        raise AppError(
            status.HTTP_503_SERVICE_UNAVAILABLE, READ_UNAVAILABLE_MESSAGE
        ) from None


def _snapshot_attachment_file_id(snapshot: dict[str, Any], ref: str) -> UUID | None:
    for message in snapshot.get("messages", []):
        for attachment in message.get("attachments", []) or []:
            if attachment.get("ref") != ref:
                continue
            raw_file_id = attachment.get("file_id")
            if not raw_file_id:
                return None
            try:
                return UUID(str(raw_file_id))
            except ValueError:
                return None
    return None


async def get_public_share_attachment_read_url(
    session: AsyncSession,
    storage: FileStorage,
    *,
    token: str,
    ref: str,
    role: str,
    settings: Settings,
    preview_storage: FileStorage | None = None,
) -> FileReadUrlResponse:
    """Exchange a share token plus attachment ref for a short-lived read URL.

    The snapshot is the authorization proof, so this is the second anonymous
    path after ``get_public_share``. Revocation, expiry, conversation deletion,
    owner deactivation and asset deletion all revoke it; snapshots minted before
    attachment reads existed carry no ``file_id`` and stay unreadable.
    """
    row = (
        await session.execute(
            select(ShareLink, Conversation.user_id)
            .join(Conversation, Conversation.id == ShareLink.conversation_id)
            .join(User, User.id == Conversation.user_id)
            .where(
                ShareLink.token == token,
                Conversation.deleted_at.is_(None),
                User.is_active.is_(True),
            )
        )
    ).first()
    if row is None:
        raise AppError(status.HTTP_404_NOT_FOUND, SHARE_NOT_FOUND_MESSAGE)
    share, owner_user_id = row
    if share.revoked_at is not None:
        raise AppError(status.HTTP_404_NOT_FOUND, SHARE_NOT_FOUND_MESSAGE)
    if share.expires_at is not None:
        now = await get_database_now(session)
        if share.expires_at <= now:
            raise AppError(status.HTTP_404_NOT_FOUND, SHARE_NOT_FOUND_MESSAGE)

    file_public_id = _snapshot_attachment_file_id(share.snapshot or {}, ref)
    if file_public_id is None:
        raise AppError(status.HTTP_404_NOT_FOUND, ATTACHMENT_NOT_FOUND_MESSAGE)
    return await issue_shared_attachment_read_url(
        session,
        storage,
        file_public_id=file_public_id,
        owner_user_id=owner_user_id,
        role=role,
        settings=settings,
        preview_storage=preview_storage,
    )
