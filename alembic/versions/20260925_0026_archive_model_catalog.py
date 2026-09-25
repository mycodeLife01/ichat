"""Archive model catalog rows instead of deleting them.

Adds ``archived_at`` to chat models, model upstreams, and model routes, and
narrows each natural-key unique constraint to unarchived rows so an archived
key can be recreated.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260925_0026"
down_revision: str | None = "20260921_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ACTIVE = sa.text("archived_at IS NULL")


def upgrade() -> None:
    for table in ("chat_models", "model_upstreams", "model_routes"):
        op.add_column(
            table,
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        )

    op.drop_constraint(op.f("uq_chat_models_key"), "chat_models", type_="unique")
    op.create_index(
        "ux_chat_models_key_active",
        "chat_models",
        ["key"],
        unique=True,
        postgresql_where=_ACTIVE,
    )
    op.drop_constraint(op.f("uq_model_upstreams_key"), "model_upstreams", type_="unique")
    op.create_index(
        "ux_model_upstreams_key_active",
        "model_upstreams",
        ["key"],
        unique=True,
        postgresql_where=_ACTIVE,
    )
    op.drop_constraint(
        "uq_model_routes_model_upstream_remote_model",
        "model_routes",
        type_="unique",
    )
    op.create_index(
        "ux_model_routes_model_upstream_remote_model_active",
        "model_routes",
        ["chat_model_id", "upstream_id", "upstream_model"],
        unique=True,
        postgresql_where=_ACTIVE,
    )


def downgrade() -> None:
    duplicates = {
        "chat_models": "SELECT key FROM chat_models GROUP BY key HAVING count(*) > 1",
        "model_upstreams": (
            "SELECT key FROM model_upstreams GROUP BY key HAVING count(*) > 1"
        ),
        "model_routes": (
            "SELECT chat_model_id FROM model_routes "
            "GROUP BY chat_model_id, upstream_id, upstream_model HAVING count(*) > 1"
        ),
    }
    bind = op.get_bind()
    for table, query in duplicates.items():
        if bind.execute(sa.text(query)).first() is not None:
            raise RuntimeError(
                f"Cannot downgrade: {table} has an archived row sharing its natural key "
                "with another row; archive or restore rows until each key has one row"
            )

    op.drop_index(
        "ux_model_routes_model_upstream_remote_model_active",
        table_name="model_routes",
    )
    op.create_unique_constraint(
        "uq_model_routes_model_upstream_remote_model",
        "model_routes",
        ["chat_model_id", "upstream_id", "upstream_model"],
    )
    op.drop_index("ux_model_upstreams_key_active", table_name="model_upstreams")
    op.create_unique_constraint(op.f("uq_model_upstreams_key"), "model_upstreams", ["key"])
    op.drop_index("ux_chat_models_key_active", table_name="chat_models")
    op.create_unique_constraint(op.f("uq_chat_models_key"), "chat_models", ["key"])

    for table in ("model_routes", "model_upstreams", "chat_models"):
        op.drop_column(table, "archived_at")
