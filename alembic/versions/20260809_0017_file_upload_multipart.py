"""Persist adaptive multipart transport state for file uploads."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260809_0017"
down_revision: str | None = "20260803_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "file_uploads",
        sa.Column("upload_method", sa.String(length=16), server_default="single", nullable=False),
    )
    op.add_column(
        "file_uploads",
        sa.Column("multipart_upload_id", sa.String(length=1024), nullable=True),
    )
    op.add_column(
        "file_uploads",
        sa.Column("multipart_part_size_bytes", sa.BigInteger(), nullable=True),
    )
    op.create_check_constraint(
        "upload_method_valid",
        "file_uploads",
        "upload_method IN ('single', 'multipart')",
    )
    op.create_check_constraint(
        "multipart_fields_valid",
        "file_uploads",
        "(upload_method = 'single' AND multipart_upload_id IS NULL "
        "AND multipart_part_size_bytes IS NULL) OR "
        "(upload_method = 'multipart' AND multipart_upload_id IS NOT NULL "
        "AND multipart_part_size_bytes >= 5242880)",
    )


def downgrade() -> None:
    op.drop_constraint(
        "multipart_fields_valid", "file_uploads", type_="check"
    )
    op.drop_constraint(
        "upload_method_valid", "file_uploads", type_="check"
    )
    op.drop_column("file_uploads", "multipart_part_size_bytes")
    op.drop_column("file_uploads", "multipart_upload_id")
    op.drop_column("file_uploads", "upload_method")
