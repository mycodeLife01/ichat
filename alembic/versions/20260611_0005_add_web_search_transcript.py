"""add web search transcript storage

Revision ID: 20260611_0005
Revises: 20260611_0004
Create Date: 2026-06-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260611_0005"
down_revision: str | None = "20260611_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_EVENT_TYPES = (
    "'run_started', 'text_delta', 'reasoning_delta', "
    "'run_succeeded', 'run_failed', 'run_cancelled'"
)
_NEW_EVENT_TYPES = (
    "'run_started', 'text_delta', 'reasoning_delta', "
    "'tool_call_started', 'tool_call_succeeded', 'tool_call_failed', "
    "'run_succeeded', 'run_failed', 'run_cancelled'"
)


def upgrade() -> None:
    op.add_column("runs", sa.Column("system_prompt_snapshot", sa.Text(), nullable=True))
    op.add_column("messages", sa.Column("metadata", postgresql.JSONB(), nullable=True))

    op.drop_constraint("ck_run_events_type_valid", "run_events", type_="check")
    op.create_check_constraint(
        "ck_run_events_type_valid",
        "run_events",
        f"type IN ({_NEW_EVENT_TYPES})",
    )

    op.create_table(
        "run_provider_messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.BigInteger(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.BigInteger(), nullable=True),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("reasoning_content", sa.Text(), nullable=True),
        sa.Column("tool_call_id", sa.String(length=255), nullable=True),
        sa.Column("tool_name", sa.String(length=100), nullable=True),
        sa.Column("tool_calls", postgresql.JSONB(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=True),
        sa.Column("estimated_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("seq > 0", name="ck_run_provider_messages_seq_positive"),
        sa.CheckConstraint(
            "role IN ('user', 'assistant', 'tool')",
            name="ck_run_provider_messages_role_valid",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["messages.id"],
            name="fk_run_provider_messages_message_id_messages",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name="fk_run_provider_messages_run_id_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_run_provider_messages"),
        sa.UniqueConstraint("run_id", "seq", name="uq_run_provider_messages_run_seq"),
    )
    op.create_index(
        "ix_run_provider_messages_run_seq",
        "run_provider_messages",
        ["run_id", "seq"],
    )
    op.create_index(
        "ix_run_provider_messages_message_id",
        "run_provider_messages",
        ["message_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_run_provider_messages_message_id", table_name="run_provider_messages")
    op.drop_index("ix_run_provider_messages_run_seq", table_name="run_provider_messages")
    op.drop_table("run_provider_messages")

    op.drop_constraint("ck_run_events_type_valid", "run_events", type_="check")
    op.create_check_constraint(
        "ck_run_events_type_valid",
        "run_events",
        f"type IN ({_OLD_EVENT_TYPES})",
    )

    op.drop_column("messages", "metadata")
    op.drop_column("runs", "system_prompt_snapshot")
