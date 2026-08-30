"""Add route reasoning outputs and split raw reasoning from summaries."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260830_0019"
down_revision: str | None = "20260829_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_routes",
        sa.Column(
            "reasoning_outputs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        op.f("ck_model_routes_reasoning_outputs_valid"),
        "model_routes",
        "reasoning_outputs IN ("
        "'[]'::jsonb, '[\"raw\"]'::jsonb, '[\"summary\"]'::jsonb, "
        "'[\"raw\", \"summary\"]'::jsonb, "
        "'[\"summary\", \"raw\"]'::jsonb"
        ")",
    )
    op.execute(
        sa.text(
            "UPDATE model_routes AS route "
            "SET reasoning_outputs = '[\"raw\"]'::jsonb "
            "FROM model_upstreams AS upstream "
            "WHERE route.upstream_id = upstream.id "
            "AND upstream.adapter = 'deepseek'"
        )
    )
    op.add_column("messages", sa.Column("reasoning_summary", sa.Text(), nullable=True))
    op.add_column(
        "run_drafts",
        sa.Column(
            "reasoning_summary",
            sa.Text(),
            server_default="",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("run_drafts", "reasoning_summary")
    op.drop_column("messages", "reasoning_summary")
    op.drop_constraint(
        op.f("ck_model_routes_reasoning_outputs_valid"),
        "model_routes",
        type_="check",
    )
    op.drop_column("model_routes", "reasoning_outputs")
