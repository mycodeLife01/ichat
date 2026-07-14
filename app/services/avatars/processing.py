from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.models.avatar import AvatarDeletion, AvatarUpload, AvatarUploadStatus
from app.models.user import User
from app.services.avatars.storage import AvatarStorage, public_avatar_url, public_object_key


class PermanentAvatarError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def render_avatar(content: bytes, *, max_bytes: int) -> bytes:
    if len(content) > max_bytes:
        raise PermanentAvatarError("invalid_image")
    try:
        with Image.open(BytesIO(content)) as image:
            if image.format != "WEBP":
                raise PermanentAvatarError("invalid_image")
            if getattr(image, "n_frames", 1) != 1:
                raise PermanentAvatarError("animated_image")
            if image.size != (1024, 1024):
                raise PermanentAvatarError("invalid_dimensions")
            image.seek(0)
            image.load()
            converted = image.convert("RGBA")
    except PermanentAvatarError:
        raise
    except (UnidentifiedImageError, OSError, ValueError):
        raise PermanentAvatarError("invalid_image") from None

    resized = converted.resize((512, 512), Image.Resampling.LANCZOS)
    output = BytesIO()
    resized.save(output, format="WEBP", quality=82, method=6, exact=True)
    return output.getvalue()


def _create_deletion(
    session: Session,
    *,
    settings: Settings,
    object_key: str,
    upload_db_id: int | None,
    now: datetime,
) -> None:
    purge_url = public_avatar_url(settings, object_key)
    if purge_url is None:
        raise RuntimeError("Avatar public base URL is required")
    session.add(
        AvatarDeletion(
            upload_id=upload_db_id,
            object_key=object_key,
            purge_url=purge_url,
            next_attempt_at=now,
        )
    )


def process_upload(
    factory: sessionmaker[Session],
    *,
    upload_id: str,
    settings: Settings,
    storage: AvatarStorage,
    task_id: str | None = None,
    now: datetime | None = None,
) -> str:
    moment = now or datetime.now(UTC)
    owner = task_id or uuid4().hex
    with factory() as session:
        upload = session.scalar(
            select(AvatarUpload).where(AvatarUpload.upload_id == upload_id).with_for_update()
        )
        if upload is None:
            return "missing"
        if upload.status == AvatarUploadStatus.SUCCEEDED:
            return "succeeded"
        user = session.get(User, upload.user_id)
        if (
            upload.status != AvatarUploadStatus.QUEUED
            or not upload.is_current
            or user is None
            or not user.is_active
        ):
            return "not_claimable"
        upload.status = AvatarUploadStatus.PROCESSING
        upload.claimed_at = moment
        upload.lease_owner = owner
        upload.lease_expires_at = moment + timedelta(
            seconds=settings.avatar_processing_lease_seconds
        )
        upload.attempt_count += 1
        object_key = upload.temporary_object_key
        attempt_count = upload.attempt_count
        session.commit()

    try:
        source = storage.get_temporary(object_key)
        rendered = render_avatar(source, max_bytes=settings.avatar_upload_max_bytes)
        final_key = public_object_key()
        storage.put_public(final_key, rendered)
    except PermanentAvatarError as exc:
        with factory() as session:
            current = session.scalar(
                select(AvatarUpload).where(AvatarUpload.upload_id == upload_id).with_for_update()
            )
            if current is not None and current.lease_owner == owner:
                current.status = AvatarUploadStatus.FAILED
                current.error_code = exc.code
                current.completed_at = moment
                current.lease_owner = None
                current.lease_expires_at = None
                session.commit()
        return exc.code
    except Exception:
        with factory() as session:
            current = session.scalar(
                select(AvatarUpload).where(AvatarUpload.upload_id == upload_id).with_for_update()
            )
            if current is not None and current.lease_owner == owner:
                current.lease_owner = None
                current.lease_expires_at = None
                if attempt_count >= settings.avatar_processing_max_attempts:
                    current.status = AvatarUploadStatus.FAILED
                    current.error_code = "processing_failed"
                    current.completed_at = moment
                else:
                    current.status = AvatarUploadStatus.QUEUED
                    current.queued_at = moment + timedelta(seconds=2**attempt_count)
                session.commit()
        return "retry" if attempt_count < settings.avatar_processing_max_attempts else "failed"

    with factory() as session:
        current = session.scalar(
            select(AvatarUpload).where(AvatarUpload.upload_id == upload_id).with_for_update()
        )
        if current is None:
            _create_deletion(
                session,
                settings=settings,
                object_key=final_key,
                upload_db_id=None,
                now=moment,
            )
            session.commit()
            return "orphaned"
        user = session.scalar(select(User).where(User.id == current.user_id).with_for_update())
        if (
            current.status != AvatarUploadStatus.PROCESSING
            or current.lease_owner != owner
            or not current.is_current
            or user is None
            or not user.is_active
        ):
            _create_deletion(
                session,
                settings=settings,
                object_key=final_key,
                upload_db_id=current.id,
                now=moment,
            )
            if current.status == AvatarUploadStatus.PROCESSING and current.lease_owner == owner:
                current.status = AvatarUploadStatus.EXPIRED
                current.error_code = (
                    "account_inactive" if user is None or not user.is_active else "superseded"
                )
                current.completed_at = moment
                current.lease_owner = None
                current.lease_expires_at = None
            session.commit()
            return "superseded"

        old_key = user.avatar_object_key
        user.avatar_object_key = final_key
        current.final_object_key = final_key
        current.status = AvatarUploadStatus.SUCCEEDED
        current.completed_at = moment
        current.lease_owner = None
        current.lease_expires_at = None
        if old_key is not None and old_key != final_key:
            _create_deletion(
                session,
                settings=settings,
                object_key=old_key,
                upload_db_id=current.id,
                now=moment,
            )
        session.commit()

    try:
        storage.delete_temporary(object_key)
        with factory() as session:
            current = session.scalar(
                select(AvatarUpload).where(AvatarUpload.upload_id == upload_id)
            )
            if current is not None:
                current.temporary_deleted_at = datetime.now(UTC)
                session.commit()
    except Exception:
        pass
    return "succeeded"
