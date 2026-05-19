"""add conversation activation timestamp

Revision ID: 20260519_0002
Revises: 20260516_0001
Create Date: 2026-05-19
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260519_0002"
down_revision: str | None = "20260516_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE conversations SET activated_at = created_at WHERE activated_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("conversations", "activated_at")
