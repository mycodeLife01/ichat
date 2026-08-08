import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy import (
    Enum as SAEnum,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from app.db.base import Base


class FilePurpose(StrEnum):
    AVATAR = "avatar"
    MESSAGE_ATTACHMENT = "message_attachment"


class FileUploadStatus(StrEnum):
    PENDING = "pending"
    QUEUED = "queued"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    REJECTED = "rejected"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class FileUploadMethod(StrEnum):
    SINGLE = "single"
    MULTIPART = "multipart"


class FileObjectRole(StrEnum):
    ORIGINAL = "original"
    PREVIEW = "preview"
    DOCUMENT_EXTRACT = "document_extract"
    AVATAR_512 = "avatar_512"


class FileModelInputKind(StrEnum):
    """Stable model-input representation available for a processed asset."""

    DOCUMENT = "document"
    IMAGE = "image"


class FileStorageLocation(StrEnum):
    CANONICAL_PRIVATE = "canonical_private"
    MODEL_PREVIEW_PRIVATE = "model_preview_private"
    AVATAR_PUBLIC = "avatar_public"


class FileUpload(Base):
    """A single bounded upload workflow; it is not the resulting file asset."""

    __tablename__ = "file_uploads"
    __table_args__ = (
        CheckConstraint("declared_size_bytes > 0", name="declared_size_positive"),
        CheckConstraint("attempt_count >= 0", name="attempt_count_non_negative"),
        CheckConstraint("purpose IN ('avatar', 'message_attachment')", name="purpose_valid"),
        CheckConstraint("upload_method IN ('single', 'multipart')", name="upload_method_valid"),
        CheckConstraint(
            "(upload_method = 'single' AND multipart_upload_id IS NULL "
            "AND multipart_part_size_bytes IS NULL) OR "
            "(upload_method = 'multipart' AND multipart_upload_id IS NOT NULL "
            "AND multipart_part_size_bytes >= 5242880)",
            name="multipart_fields_valid",
        ),
        CheckConstraint(
            "status IN "
            "('pending', 'queued', 'processing', 'succeeded', 'rejected', 'failed', "
            "'expired', 'cancelled')",
            name="status_valid",
        ),
        Index("ix_file_uploads_user_purpose_status", "user_id", "purpose", "status"),
        Index("ix_file_uploads_status_available_at", "status", "available_at"),
        Index("ix_file_uploads_lease_expires_at", "lease_expires_at"),
        Index("ix_file_uploads_expires_at", "expires_at"),
        Index("ix_file_uploads_file_id", "file_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    public_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        nullable=False,
        unique=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    purpose: Mapped[FilePurpose] = mapped_column(
        SAEnum(
            FilePurpose,
            native_enum=False,
            values_callable=lambda purposes: [purpose.value for purpose in purposes],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
    )
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    declared_content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    declared_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    staging_object_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    upload_method: Mapped[FileUploadMethod] = mapped_column(
        SAEnum(
            FileUploadMethod,
            native_enum=False,
            values_callable=lambda methods: [method.value for method in methods],
            validate_strings=True,
            length=16,
        ),
        nullable=False,
        server_default=FileUploadMethod.SINGLE.value,
    )
    multipart_upload_id: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    multipart_part_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    confirmed_etag: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[FileUploadStatus] = mapped_column(
        SAEnum(
            FileUploadStatus,
            native_enum=False,
            values_callable=lambda statuses: [status.value for status in statuses],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
        server_default=FileUploadStatus.PENDING.value,
    )
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lease_owner: Mapped[str | None] = mapped_column(String(255), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    queued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    output_manifest: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB(none_as_null=True),
        nullable=True,
    )
    file_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("files.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
    staging_deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

class FileAsset(Base):
    """An immutable, successfully processed logical file usable by the product."""

    __tablename__ = "files"
    __table_args__ = (
        CheckConstraint("size_bytes >= 0", name="size_non_negative"),
        CheckConstraint("purpose IN ('avatar', 'message_attachment')", name="purpose_valid"),
        CheckConstraint(
            "model_input_kind IS NULL OR model_input_kind IN ('document', 'image')",
            name="model_input_kind_valid",
        ),
        Index("ix_files_user_purpose", "user_id", "purpose"),
        Index("ix_files_source_message_id", "source_message_id"),
        Index("ix_files_unbound_expires_at", "unbound_expires_at"),
        Index("ix_files_detached_at", "detached_at"),
        Index("ix_files_deletion_started_at", "deletion_started_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    public_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        nullable=False,
        unique=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    purpose: Mapped[FilePurpose] = mapped_column(
        SAEnum(
            FilePurpose,
            native_enum=False,
            values_callable=lambda purposes: [purpose.value for purpose in purposes],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
    )
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    warnings: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    extractor_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    summary_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # Canonical derived text remains database-owned while an asset is unbound;
    # workers and provider paths therefore never need cross-credential object reads.
    document_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    model_input_kind: Mapped[FileModelInputKind | None] = mapped_column(
        SAEnum(
            FileModelInputKind,
            native_enum=False,
            values_callable=lambda kinds: [kind.value for kind in kinds],
            validate_strings=True,
            length=16,
        ),
        nullable=True,
    )
    unbound_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    source_message_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    bound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    detached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deletion_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

class FileObject(Base):
    """A controlled physical representation of a file asset in object storage."""

    __tablename__ = "file_objects"
    __table_args__ = (
        CheckConstraint("size_bytes >= 0", name="size_non_negative"),
        CheckConstraint(
            "role IN ('original', 'preview', 'document_extract', 'avatar_512')", name="role_valid"
        ),
        CheckConstraint(
            "storage_location IN ('canonical_private', 'model_preview_private', 'avatar_public')",
            name="storage_location_valid",
        ),
        UniqueConstraint("file_id", "role", name="uq_file_objects_file_role"),
        UniqueConstraint(
            "storage_location",
            "object_key",
            name="uq_file_objects_storage_object_key",
        ),
        Index("ix_file_objects_file_id", "file_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    file_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("files.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[FileObjectRole] = mapped_column(
        SAEnum(
            FileObjectRole,
            native_enum=False,
            values_callable=lambda roles: [role.value for role in roles],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
    )
    storage_location: Mapped[FileStorageLocation] = mapped_column(
        SAEnum(
            FileStorageLocation,
            native_enum=False,
            values_callable=lambda locations: [location.value for location in locations],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
    )
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    media_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MessageAttachment(Base):
    """Explicit message-to-file association with immutable display/share metadata."""

    __tablename__ = "message_attachments"
    __table_args__ = (
        CheckConstraint("position >= 0", name="position_non_negative"),
        CheckConstraint("size_bytes >= 0", name="size_non_negative"),
        UniqueConstraint("message_id", "position", name="uq_message_attachments_message_position"),
        Index("ix_message_attachments_file_id", "file_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    message_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Historical/archived message metadata must survive when a detached asset is
    # reclaimed, so its live asset reference can be set to NULL by the database.
    file_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("files.id", ondelete="SET NULL"),
        nullable=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    warnings: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class FileQuota(Base):
    """Per-user transactional quota row; callers lock this row before changing bytes."""

    __tablename__ = "file_quotas"
    __table_args__ = (
        CheckConstraint("used_bytes >= 0", name="used_bytes_non_negative"),
        CheckConstraint("reserved_bytes >= 0", name="reserved_bytes_non_negative"),
    )

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    used_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    reserved_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class FileObjectDeletion(Base):
    """Durable external-deletion compensation for one storage object."""

    __tablename__ = "file_object_deletions"
    __table_args__ = (
        CheckConstraint("attempt_count >= 0", name="attempt_count_non_negative"),
        CheckConstraint(
            "storage_location IN ('canonical_private', 'model_preview_private', 'avatar_public')",
            name="storage_location_valid",
        ),
        UniqueConstraint(
            "storage_location",
            "object_key",
            name="uq_file_object_deletions_storage_object_key",
        ),
        Index(
            "ix_file_object_deletions_completed_available",
            "completed_at",
            "available_at",
        ),
        Index("ix_file_object_deletions_file_object_id", "file_object_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    file_object_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("file_objects.id", ondelete="SET NULL"),
        nullable=True,
    )
    storage_location: Mapped[FileStorageLocation] = mapped_column(
        SAEnum(
            FileStorageLocation,
            native_enum=False,
            values_callable=lambda locations: [location.value for location in locations],
            validate_strings=True,
            length=32,
        ),
        nullable=False,
    )
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    purge_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    object_deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cdn_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    error_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
