"""add public_id to conversations, runs, messages

Revision ID: 20260618_0006
Revises: 20260611_0005
Create Date: 2026-06-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260618_0006"
down_revision: str | None = "20260611_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables that gain an opaque external identifier. PostgreSQL 16 ships
# gen_random_uuid() in core, so the backfill needs no extension.
_TABLES = ("conversations", "runs", "messages")


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column("public_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.execute(f"UPDATE {table} SET public_id = gen_random_uuid() WHERE public_id IS NULL")
        op.alter_column(
            table,
            "public_id",
            existing_type=postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        )
        op.create_unique_constraint(f"uq_{table}_public_id", table, ["public_id"])


def downgrade() -> None:
    for table in _TABLES:
        op.drop_constraint(f"uq_{table}_public_id", table, type_="unique")
        op.drop_column(table, "public_id")
