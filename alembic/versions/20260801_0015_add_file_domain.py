"""add unified file domain tables and legacy avatar references

Revision ID: 20260801_0015
Revises: 20260720_0014
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260801_0015"
down_revision: str | None = "20260720_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "files",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "public_id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("extractor_version", sa.String(length=100), nullable=True),
        sa.Column("summary_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("document_text", sa.Text(), nullable=True),
        sa.Column(
            "model_consumable", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("unbound_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_message_id", sa.BigInteger(), nullable=True),
        sa.Column("bound_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("detached_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deletion_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("size_bytes >= 0", name="ck_files_size_non_negative"),
        sa.CheckConstraint(
            "purpose IN ('avatar', 'message_attachment')", name="ck_files_purpose_valid"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_message_id"], ["messages.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("public_id", name="uq_files_public_id"),
    )
    op.create_index("ix_files_user_purpose", "files", ["user_id", "purpose"])
    op.create_index("ix_files_source_message_id", "files", ["source_message_id"])
    op.create_index("ix_files_unbound_expires_at", "files", ["unbound_expires_at"])
    op.create_index("ix_files_detached_at", "files", ["detached_at"])
    op.create_index("ix_files_deletion_started_at", "files", ["deletion_started_at"])

    op.create_table(
        "file_uploads",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "public_id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("declared_content_type", sa.String(length=255), nullable=False),
        sa.Column("declared_size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("staging_object_key", sa.String(length=512), nullable=False),
        sa.Column("confirmed_etag", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lease_owner", sa.String(length=255), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(length=100), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("output_manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("file_id", sa.BigInteger(), nullable=True),
        sa.Column("staging_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "declared_size_bytes > 0", name="ck_file_uploads_declared_size_positive"
        ),
        sa.CheckConstraint("attempt_count >= 0", name="ck_file_uploads_attempt_count_non_negative"),
        sa.CheckConstraint(
            "purpose IN ('avatar', 'message_attachment')", name="ck_file_uploads_purpose_valid"
        ),
        sa.CheckConstraint(
            "status IN "
            "('pending', 'queued', 'processing', 'succeeded', 'rejected', 'failed', "
            "'expired', 'cancelled')",
            name="ck_file_uploads_status_valid",
        ),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("file_id", name="uq_file_uploads_file_id"),
        sa.UniqueConstraint("public_id", name="uq_file_uploads_public_id"),
        sa.UniqueConstraint("staging_object_key", name="uq_file_uploads_staging_object_key"),
    )
    op.create_index(
        "ix_file_uploads_user_purpose_status", "file_uploads", ["user_id", "purpose", "status"]
    )
    op.create_index(
        "ix_file_uploads_status_available_at", "file_uploads", ["status", "available_at"]
    )
    op.create_index("ix_file_uploads_lease_expires_at", "file_uploads", ["lease_expires_at"])
    op.create_index("ix_file_uploads_expires_at", "file_uploads", ["expires_at"])
    op.create_index("ix_file_uploads_file_id", "file_uploads", ["file_id"])

    op.create_table(
        "file_objects",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("file_id", sa.BigInteger(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("storage_location", sa.String(length=32), nullable=False),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("media_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("size_bytes >= 0", name="ck_file_objects_size_non_negative"),
        sa.CheckConstraint(
            "role IN ('original', 'preview', 'document_extract', 'avatar_512')",
            name="ck_file_objects_role_valid",
        ),
        sa.CheckConstraint(
            "storage_location IN ('canonical_private', 'avatar_public')",
            name="ck_file_objects_storage_location_valid",
        ),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("file_id", "role", name="uq_file_objects_file_role"),
        sa.UniqueConstraint(
            "storage_location",
            "object_key",
            name="uq_file_objects_storage_object_key",
        ),
    )
    op.create_index("ix_file_objects_file_id", "file_objects", ["file_id"])

    op.create_table(
        "message_attachments",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("message_id", sa.BigInteger(), nullable=False),
        sa.Column("file_id", sa.BigInteger(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("position >= 0", name="ck_message_attachments_position_non_negative"),
        sa.CheckConstraint("size_bytes >= 0", name="ck_message_attachments_size_non_negative"),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "message_id", "position", name="uq_message_attachments_message_position"
        ),
    )
    op.create_index("ix_message_attachments_file_id", "message_attachments", ["file_id"])

    op.create_table(
        "file_quotas",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("used_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("reserved_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("used_bytes >= 0", name="ck_file_quotas_used_bytes_non_negative"),
        sa.CheckConstraint(
            "reserved_bytes >= 0", name="ck_file_quotas_reserved_bytes_non_negative"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "file_object_deletions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("file_object_id", sa.BigInteger(), nullable=True),
        sa.Column("storage_location", sa.String(length=32), nullable=False),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("purge_url", sa.String(length=2048), nullable=True),
        sa.Column("object_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cdn_purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("error_summary", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "attempt_count >= 0", name="ck_file_object_deletions_attempt_count_non_negative"
        ),
        sa.CheckConstraint(
            "storage_location IN ('canonical_private', 'avatar_public')",
            name="ck_file_object_deletions_storage_location_valid",
        ),
        sa.ForeignKeyConstraint(["file_object_id"], ["file_objects.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "storage_location",
            "object_key",
            name="uq_file_object_deletions_storage_object_key",
        ),
    )
    op.create_index(
        "ix_file_object_deletions_completed_available",
        "file_object_deletions",
        ["completed_at", "available_at"],
    )
    op.create_index(
        "ix_file_object_deletions_file_object_id", "file_object_deletions", ["file_object_id"]
    )

    op.add_column("users", sa.Column("avatar_file_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        "fk_users_avatar_file_id_files",
        "users",
        "files",
        ["avatar_file_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint("uq_users_avatar_file_id", "users", ["avatar_file_id"])

    # Existing keys are random public-avatar keys. Import only unambiguous keys;
    # a duplicate stays on the legacy fallback rather than silently modelling a
    # shared physical object in the new no-dedup domain. This reads PostgreSQL
    # metadata only and intentionally does not call R2.
    op.execute(
        sa.text(
            """
            WITH imported AS (
                INSERT INTO files (
                    public_id,
                    user_id,
                    purpose,
                    original_filename,
                    media_type,
                    size_bytes,
                    sha256,
                    warnings,
                    extractor_version,
                    summary_metadata,
                    document_text,
                    model_consumable,
                    unbound_expires_at,
                    source_message_id,
                    bound_at,
                    detached_at,
                    deletion_started_at
                )
                SELECT
                    gen_random_uuid(),
                    user_row.id,
                    'avatar',
                    'legacy-avatar.webp',
                    'image/webp',
                    0,
                    NULL,
                    '["legacy_import"]'::jsonb,
                    'legacy-import',
                    '{"legacy_import": true, "size_bytes": "unknown", "sha256": "unknown"}'::jsonb,
                    NULL,
                    false,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    NULL
                FROM users AS user_row
                WHERE user_row.avatar_file_id IS NULL
                  AND user_row.avatar_object_key IS NOT NULL
                  AND btrim(user_row.avatar_object_key) <> ''
                  AND 1 = (
                      SELECT count(*)
                      FROM users AS same_key
                      WHERE same_key.avatar_object_key = user_row.avatar_object_key
                  )
                RETURNING id, user_id
            )
            UPDATE users AS user_row
            SET avatar_file_id = imported.id
            FROM imported
            WHERE user_row.id = imported.user_id
            """
        )
    )
    op.execute(
        sa.text(
            """
            INSERT INTO file_objects (
                file_id,
                role,
                storage_location,
                object_key,
                media_type,
                size_bytes,
                sha256
            )
            SELECT
                user_row.avatar_file_id,
                'avatar_512',
                'avatar_public',
                user_row.avatar_object_key,
                'image/webp',
                0,
                NULL
            FROM users AS user_row
            WHERE user_row.avatar_file_id IS NOT NULL
              AND user_row.avatar_object_key IS NOT NULL
              AND btrim(user_row.avatar_object_key) <> ''
            """
        )
    )
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM users
                    WHERE avatar_object_key IS NOT NULL
                    GROUP BY avatar_object_key
                    HAVING count(*) > 1
                ) THEN
                    RAISE NOTICE
                        'Legacy avatar object-key duplicates were left on the legacy fallback.';
                END IF;
            END $$;
            """
        )
    )

    op.execute(
        sa.text(
            """
            INSERT INTO file_quotas (user_id)
            SELECT id
            FROM users
            ON CONFLICT (user_id) DO NOTHING
            """
        )
    )

    op.add_column(
        "conversations",
        sa.Column("deletion_due_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing soft-deleted conversations predate the restore product. Give
    # every one of them a full restore window from this migration rather than
    # making old rows immediately eligible for irreversible purge.
    op.execute(
        sa.text(
            """
            UPDATE conversations
            SET deletion_due_at = now() + interval '30 days'
            WHERE deleted_at IS NOT NULL
              AND deletion_due_at IS NULL
            """
        )
    )
    op.create_index("ix_conversations_deletion_due_at", "conversations", ["deletion_due_at"])


def downgrade() -> None:
    # The old avatar key remains intact, so legacy-only avatar imports can be
    # removed. Do not silently discard any real unified-file data on rollback.
    bind = op.get_bind()
    has_non_legacy_data = bind.execute(
        sa.text(
            """
            SELECT EXISTS (
                SELECT 1 FROM file_uploads
                UNION ALL
                SELECT 1 FROM message_attachments
                UNION ALL
                SELECT 1 FROM file_object_deletions
                UNION ALL
                SELECT 1
                FROM files
                WHERE purpose <> 'avatar'
                   OR NOT COALESCE(
                       summary_metadata @> '{"legacy_import": true}'::jsonb,
                       false
                   )
            )
            """
        )
    ).scalar()
    if has_non_legacy_data:
        raise RuntimeError(
            "Refusing to downgrade unified files while non-legacy file data exists. "
            "Drain or migrate that data before rollback."
        )

    op.drop_index("ix_conversations_deletion_due_at", table_name="conversations")
    op.drop_column("conversations", "deletion_due_at")

    op.drop_constraint("uq_users_avatar_file_id", "users", type_="unique")
    op.drop_constraint("fk_users_avatar_file_id_files", "users", type_="foreignkey")
    op.drop_column("users", "avatar_file_id")

    op.drop_index("ix_file_object_deletions_file_object_id", table_name="file_object_deletions")
    op.drop_index(
        "ix_file_object_deletions_completed_available", table_name="file_object_deletions"
    )
    op.drop_table("file_object_deletions")
    op.drop_index("ix_message_attachments_file_id", table_name="message_attachments")
    op.drop_table("message_attachments")
    op.drop_index("ix_file_uploads_file_id", table_name="file_uploads")
    op.drop_index("ix_file_uploads_expires_at", table_name="file_uploads")
    op.drop_index("ix_file_uploads_lease_expires_at", table_name="file_uploads")
    op.drop_index("ix_file_uploads_status_available_at", table_name="file_uploads")
    op.drop_index("ix_file_uploads_user_purpose_status", table_name="file_uploads")
    op.drop_table("file_uploads")
    op.drop_index("ix_file_objects_file_id", table_name="file_objects")
    op.drop_table("file_objects")
    op.drop_table("file_quotas")
    op.drop_index("ix_files_deletion_started_at", table_name="files")
    op.drop_index("ix_files_detached_at", table_name="files")
    op.drop_index("ix_files_unbound_expires_at", table_name="files")
    op.drop_index("ix_files_source_message_id", table_name="files")
    op.drop_index("ix_files_user_purpose", table_name="files")
    op.drop_table("files")
