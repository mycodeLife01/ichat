from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.avatar import AvatarDeletion, AvatarUpload, AvatarUploadStatus
from app.models.user import User
from app.services.avatars.storage import public_avatar_url


async def deactivate_user_avatar(
    session: AsyncSession,
    *,
    user: User,
    settings: Settings,
    now: datetime | None = None,
) -> None:
    moment = now or datetime.now(UTC)
    await session.execute(
        update(AvatarUpload)
        .where(
            AvatarUpload.user_id == user.id,
            AvatarUpload.status.in_(
                [
                    AvatarUploadStatus.PENDING,
                    AvatarUploadStatus.QUEUED,
                    AvatarUploadStatus.PROCESSING,
                ]
            ),
        )
        .values(
            is_current=False,
            status=AvatarUploadStatus.EXPIRED,
            error_code="account_inactive",
            completed_at=moment,
            lease_owner=None,
            lease_expires_at=None,
        )
    )
    object_key = user.avatar_object_key
    user.avatar_object_key = None
    if object_key is not None:
        purge_url = public_avatar_url(settings, object_key)
        if purge_url is None:
            raise RuntimeError("Avatar public base URL is required")
        session.add(
            AvatarDeletion(
                object_key=object_key,
                purge_url=purge_url,
                next_attempt_at=moment,
            )
        )
    await session.flush()


async def take_down_user_avatar(
    session: AsyncSession,
    *,
    user: User,
    settings: Settings,
    now: datetime | None = None,
) -> bool:
    if user.avatar_object_key is None:
        return False
    moment = now or datetime.now(UTC)
    object_key = user.avatar_object_key
    purge_url = public_avatar_url(settings, object_key)
    if purge_url is None:
        raise RuntimeError("Avatar public base URL is required")
    user.avatar_object_key = None
    session.add(AvatarDeletion(object_key=object_key, purge_url=purge_url, next_attempt_at=moment))
    await session.flush()
    return True
