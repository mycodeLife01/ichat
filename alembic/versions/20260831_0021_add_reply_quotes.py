"""Add immutable reply quote snapshots to user messages."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260831_0021"
down_revision: str | None = "20260830_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("reply_quote_source_message_id", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("reply_quote_excerpt", sa.Text(), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_messages_reply_quote_source_message_id_messages"),
        "messages",
        "messages",
        ["reply_quote_source_message_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        op.f("ck_messages_reply_quote_source_requires_excerpt"),
        "messages",
        "reply_quote_source_message_id IS NULL OR reply_quote_excerpt IS NOT NULL",
    )
    op.create_check_constraint(
        op.f("ck_messages_reply_quote_user_only"),
        "messages",
        "reply_quote_excerpt IS NULL OR role = 'user'",
    )
    op.create_check_constraint(
        op.f("ck_messages_reply_quote_excerpt_valid"),
        "messages",
        "reply_quote_excerpt IS NULL OR ("
        "char_length(reply_quote_excerpt) BETWEEN 1 AND 4000 "
        "AND reply_quote_excerpt !~ '^[[:space:]]*$'"
        ")",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_messages_reply_quote_excerpt_valid"),
        "messages",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_messages_reply_quote_user_only"),
        "messages",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_messages_reply_quote_source_requires_excerpt"),
        "messages",
        type_="check",
    )
    op.drop_constraint(
        op.f("fk_messages_reply_quote_source_message_id_messages"),
        "messages",
        type_="foreignkey",
    )
    op.drop_column("messages", "reply_quote_excerpt")
    op.drop_column("messages", "reply_quote_source_message_id")
