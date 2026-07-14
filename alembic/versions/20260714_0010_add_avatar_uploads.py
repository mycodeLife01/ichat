"""add avatar uploads and deletion compensation

Revision ID: 20260714_0010
Revises: 20260714_0009
Create Date: 2026-07-14
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260714_0010"
down_revision: str | None = "20260714_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_object_key", sa.String(length=255), nullable=True))
    op.create_table(
        "avatar_uploads",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("upload_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("temporary_object_key", sa.String(length=255), nullable=False),
        sa.Column("declared_size_bytes", sa.Integer(), nullable=False),
        sa.Column("etag", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("is_current", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("final_object_key", sa.String(length=255), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_owner", sa.String(length=255), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("temporary_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("temporary_object_key"),
        sa.UniqueConstraint("upload_id"),
    )
    op.create_index("ix_avatar_uploads_user_status", "avatar_uploads", ["user_id", "status"])
    op.create_index("ix_avatar_uploads_status_queued_at", "avatar_uploads", ["status", "queued_at"])
    op.create_index("ix_avatar_uploads_lease_expires_at", "avatar_uploads", ["lease_expires_at"])
    op.create_index("ix_avatar_uploads_expires_at", "avatar_uploads", ["expires_at"])
    op.create_index("ix_avatar_uploads_completed_at", "avatar_uploads", ["completed_at"])

    op.create_table(
        "avatar_deletions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("upload_id", sa.BigInteger(), nullable=True),
        sa.Column("object_key", sa.String(length=255), nullable=False),
        sa.Column("purge_url", sa.String(length=2048), nullable=False),
        sa.Column("object_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cdn_purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["upload_id"], ["avatar_uploads.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_avatar_deletions_next_attempt_at",
        "avatar_deletions",
        ["completed_at", "next_attempt_at"],
    )
    op.create_index("ix_avatar_deletions_upload_id", "avatar_deletions", ["upload_id"])


def downgrade() -> None:
    op.drop_table("avatar_deletions")
    op.drop_table("avatar_uploads")
    op.drop_column("users", "avatar_object_key")
