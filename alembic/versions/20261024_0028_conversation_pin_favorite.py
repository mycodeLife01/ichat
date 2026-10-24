"""Add sidebar pin and favorite markers to conversations.

Adds nullable ``conversations.pinned_at`` and ``conversations.favorited_at``
with partial indexes over the live, marked rows of each user.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20261024_0028"
down_revision: str | None = "20260927_0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("favorited_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_conversations_user_pinned",
        "conversations",
        ["user_id", "pinned_at"],
        postgresql_where=sa.text("pinned_at IS NOT NULL AND deleted_at IS NULL"),
    )
    op.create_index(
        "ix_conversations_user_favorited",
        "conversations",
        ["user_id", "favorited_at"],
        postgresql_where=sa.text("favorited_at IS NOT NULL AND deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_user_favorited", table_name="conversations")
    op.drop_index("ix_conversations_user_pinned", table_name="conversations")
    op.drop_column("conversations", "favorited_at")
    op.drop_column("conversations", "pinned_at")
