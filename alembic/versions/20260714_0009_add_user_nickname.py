"""add independent user nickname

Revision ID: 20260714_0009
Revises: 20260621_0008
Create Date: 2026-07-14
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260714_0009"
down_revision: str | None = "20260621_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("nickname", sa.String(length=50), nullable=True))
    op.execute("UPDATE users SET nickname = username")
    op.alter_column("users", "nickname", nullable=False)
    op.create_check_constraint("nickname_not_empty", "users", "nickname <> ''")


def downgrade() -> None:
    op.drop_constraint("nickname_not_empty", "users", type_="check")
    op.drop_column("users", "nickname")
