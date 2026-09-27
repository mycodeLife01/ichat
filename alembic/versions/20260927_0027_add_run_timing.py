"""Add worker-measured timing to runs.

Adds nullable ``runs.timing`` JSONB. Existing rows stay NULL: reasoning and
answer deltas were never persisted, so their phases cannot be backfilled.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260927_0027"
down_revision: str | None = "20260925_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column("timing", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("runs", "timing")
