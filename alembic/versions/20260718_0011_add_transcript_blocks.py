"""add provider-neutral transcript blocks

Revision ID: 20260718_0011
Revises: 20260714_0010
Create Date: 2026-07-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260718_0011"
down_revision: str | None = "20260714_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "run_provider_messages",
        sa.Column("blocks", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("run_provider_messages", "blocks")
