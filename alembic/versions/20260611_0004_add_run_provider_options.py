"""add runs.provider_options for per-run thinking configuration

Revision ID: 20260611_0004
Revises: 20260521_0003
Create Date: 2026-06-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "20260611_0004"
down_revision: str | None = "20260521_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("provider_options", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "provider_options")
