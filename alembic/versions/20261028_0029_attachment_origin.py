"""Record whether a message attachment was uploaded or pasted.

Adds ``origin`` to ``file_uploads``, ``files`` and ``message_attachments``.
Existing rows are backfilled as ``upload``; nothing is inferred from names.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261028_0029"
down_revision: str | None = "20261024_0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = ("file_uploads", "files", "message_attachments")


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column("origin", sa.String(length=16), server_default="upload", nullable=False),
        )
        op.create_check_constraint("origin_valid", table, "origin IN ('upload', 'paste')")


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_constraint("origin_valid", table, type_="check")
        op.drop_column(table, "origin")
