from datetime import datetime
from enum import StrEnum

from sqlalchemy import BigInteger, Boolean, DateTime, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class AvatarUploadStatus(StrEnum):
    PENDING = "pending"
    QUEUED = "queued"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    EXPIRED = "expired"


class AvatarUpload(Base):
    __tablename__ = "avatar_uploads"
    __table_args__ = (
        Index("ix_avatar_uploads_user_status", "user_id", "status"),
        Index("ix_avatar_uploads_status_queued_at", "status", "queued_at"),
        Index("ix_avatar_uploads_lease_expires_at", "lease_expires_at"),
        Index("ix_avatar_uploads_expires_at", "expires_at"),
        Index("ix_avatar_uploads_completed_at", "completed_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    upload_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    temporary_object_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    declared_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    etag: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[AvatarUploadStatus] = mapped_column(
        Enum(
            AvatarUploadStatus,
            native_enum=False,
            values_callable=lambda statuses: [status.value for status in statuses],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
        server_default=AvatarUploadStatus.PENDING.value,
    )
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    final_object_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_owner: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    temporary_deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AvatarDeletion(Base):
    __tablename__ = "avatar_deletions"
    __table_args__ = (
        Index("ix_avatar_deletions_next_attempt_at", "completed_at", "next_attempt_at"),
        Index("ix_avatar_deletions_upload_id", "upload_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    upload_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("avatar_uploads.id", ondelete="SET NULL"),
        nullable=True,
    )
    object_key: Mapped[str] = mapped_column(String(255), nullable=False)
    purge_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    object_deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cdn_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
