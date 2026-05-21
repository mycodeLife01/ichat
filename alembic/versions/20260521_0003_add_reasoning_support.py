"""add reasoning support: run_events reasoning_delta type, messages.reasoning

Revision ID: 20260521_0003
Revises: 20260519_0002
Create Date: 2026-05-21
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260521_0003"
down_revision: str | None = "20260519_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_TYPES = "'run_started', 'text_delta', 'run_succeeded', 'run_failed', 'run_cancelled'"
_NEW_TYPES = (
    "'run_started', 'text_delta', 'reasoning_delta', "
    "'run_succeeded', 'run_failed', 'run_cancelled'"
)


def upgrade() -> None:
    op.drop_constraint("ck_run_events_type_valid", "run_events", type_="check")
    op.create_check_constraint(
        "ck_run_events_type_valid", "run_events", f"type IN ({_NEW_TYPES})"
    )
    op.add_column("messages", sa.Column("reasoning", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "reasoning")
    op.drop_constraint("ck_run_events_type_valid", "run_events", type_="check")
    op.create_check_constraint(
        "ck_run_events_type_valid", "run_events", f"type IN ({_OLD_TYPES})"
    )
