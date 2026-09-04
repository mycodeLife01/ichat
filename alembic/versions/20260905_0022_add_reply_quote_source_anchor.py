"""Add versioned source anchors to reply quote snapshots."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260905_0022"
down_revision: str | None = "20260831_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("reply_quote_source_anchor_version", sa.SmallInteger(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("reply_quote_source_anchor_start", sa.Integer(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("reply_quote_source_anchor_end", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_messages_reply_quote_source_anchor_valid"),
        "messages",
        "(reply_quote_source_anchor_version IS NULL "
        "AND reply_quote_source_anchor_start IS NULL "
        "AND reply_quote_source_anchor_end IS NULL) "
        "OR (reply_quote_source_anchor_version IS NOT NULL "
        "AND reply_quote_source_anchor_start IS NOT NULL "
        "AND reply_quote_source_anchor_end IS NOT NULL "
        "AND reply_quote_source_anchor_version = 1 "
        "AND reply_quote_source_anchor_start >= 0 "
        "AND reply_quote_source_anchor_end > reply_quote_source_anchor_start "
        "AND role = 'user' "
        "AND reply_quote_excerpt IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_messages_reply_quote_source_anchor_valid"),
        "messages",
        type_="check",
    )
    op.drop_column("messages", "reply_quote_source_anchor_end")
    op.drop_column("messages", "reply_quote_source_anchor_start")
    op.drop_column("messages", "reply_quote_source_anchor_version")
