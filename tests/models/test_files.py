from sqlalchemy import BigInteger, CheckConstraint, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

import app.models  # noqa: F401
from app.db.base import Base
from app.models.files import (
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
    FileUploadStatus,
)


def _check_sql(table_name: str) -> set[str]:
    return {
        str(constraint.sqltext)
        for constraint in Base.metadata.tables[table_name].constraints
        if isinstance(constraint, CheckConstraint)
    }


def test_file_domain_uses_fixed_vocabulary() -> None:
    assert {purpose.value for purpose in FilePurpose} == {"avatar", "message_attachment"}
    assert {status.value for status in FileUploadStatus} == {
        "pending",
        "queued",
        "processing",
        "succeeded",
        "rejected",
        "failed",
        "expired",
        "cancelled",
    }
    assert {role.value for role in FileObjectRole} == {
        "original",
        "preview",
        "document_extract",
        "avatar_512",
    }
    assert {location.value for location in FileStorageLocation} == {
        "canonical_private",
        "model_preview_private",
        "avatar_public",
    }


def test_file_upload_and_asset_store_the_required_lifecycle_facts() -> None:
    uploads = Base.metadata.tables["file_uploads"]
    files = Base.metadata.tables["files"]

    assert isinstance(uploads.c.public_id.type, UUID)
    assert uploads.c.public_id.unique is True
    assert {
        "public_id",
        "user_id",
        "purpose",
        "original_filename",
        "declared_content_type",
        "declared_size_bytes",
        "staging_object_key",
        "confirmed_etag",
        "status",
        "attempt_count",
        "available_at",
        "lease_owner",
        "lease_expires_at",
        "error_code",
        "expires_at",
        "queued_at",
        "claimed_at",
        "completed_at",
        "output_manifest",
        "file_id",
        "staging_deleted_at",
    } <= set(uploads.c.keys())
    assert "purpose IN ('avatar', 'message_attachment')" in _check_sql("file_uploads")
    assert any("status IN" in sql and "cancelled" in sql for sql in _check_sql("file_uploads"))

    assert isinstance(files.c.public_id.type, UUID)
    assert files.c.public_id.unique is True
    assert isinstance(files.c.warnings.type, JSONB)
    assert isinstance(files.c.summary_metadata.type, JSONB)
    assert isinstance(files.c.document_text.type, Text)
    assert {
        "unbound_expires_at",
        "source_message_id",
        "bound_at",
        "detached_at",
        "deletion_started_at",
    } <= set(files.c.keys())


def test_file_references_are_explicit_and_keep_historical_attachment_metadata() -> None:
    users = Base.metadata.tables["users"]
    files = Base.metadata.tables["files"]
    attachments = Base.metadata.tables["message_attachments"]

    avatar_fk = next(iter(users.c.avatar_file_id.foreign_keys))
    assert avatar_fk.column.table.name == "files"
    assert avatar_fk.ondelete == "SET NULL"
    assert users.c.avatar_file_id.unique is True

    source_message_fk = next(iter(files.c.source_message_id.foreign_keys))
    assert source_message_fk.column.table.name == "messages"
    assert source_message_fk.ondelete == "SET NULL"

    attachment_file_fk = next(iter(attachments.c.file_id.foreign_keys))
    assert attachment_file_fk.column.table.name == "files"
    assert attachment_file_fk.ondelete == "SET NULL"
    assert attachments.c.file_id.nullable is True
    assert isinstance(attachments.c.warnings.type, JSONB)
    assert {
        "position",
        "name",
        "media_type",
        "size_bytes",
        "warnings",
    } <= set(attachments.c.keys())
    assert any(
        isinstance(constraint, UniqueConstraint)
        and [column.name for column in constraint.columns] == ["message_id", "position"]
        for constraint in attachments.constraints
    )


def test_quota_and_deletion_compensation_are_database_state_rows() -> None:
    quota = Base.metadata.tables["file_quotas"]
    deletions = Base.metadata.tables["file_object_deletions"]
    conversations = Base.metadata.tables["conversations"]

    assert [column.name for column in quota.primary_key.columns] == ["user_id"]
    assert isinstance(quota.c.used_bytes.type, BigInteger)
    assert isinstance(quota.c.reserved_bytes.type, BigInteger)
    assert {"used_bytes >= 0", "reserved_bytes >= 0"} <= _check_sql("file_quotas")

    assert {
        "file_object_id",
        "storage_location",
        "object_key",
        "purge_url",
        "object_deleted_at",
        "cdn_purged_at",
        "attempt_count",
        "available_at",
        "error_summary",
        "completed_at",
    } <= set(deletions.c.keys())
    assert "deletion_due_at" in conversations.c
    assert any(index.name == "ix_conversations_deletion_due_at" for index in conversations.indexes)
