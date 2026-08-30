"""Add the database-backed chat-model catalog and Run route snapshots."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20260829_0018"
down_revision: str | None = "20260809_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "runs",
        "provider_model",
        existing_type=sa.String(length=100),
        type_=sa.String(length=256),
        existing_nullable=False,
    )
    op.create_table(
        "model_catalog_state",
        sa.Column("id", sa.BigInteger(), server_default="1", nullable=False),
        sa.Column(
            "database_enabled",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name=op.f("ck_model_catalog_state_singleton")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_catalog_state")),
    )
    op.execute(
        sa.text(
            "INSERT INTO model_catalog_state (id, database_enabled) "
            "VALUES (1, false)"
        )
    )

    op.create_table(
        "chat_models",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="100", nullable=False),
        sa.Column(
            "thinking_levels",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "supports_image_input",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("image_token_reserve", sa.Integer(), nullable=True),
        sa.Column("token_profile", sa.String(length=20), server_default="default", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "sort_order >= 0",
            name=op.f("ck_chat_models_sort_order_non_negative"),
        ),
        sa.CheckConstraint(
            "token_profile IN ('default', 'deepseek', 'openai')",
            name=op.f("ck_chat_models_token_profile_valid"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(thinking_levels) = 'array'",
            name=op.f("ck_chat_models_thinking_levels_array"),
        ),
        sa.CheckConstraint(
            "(supports_image_input = false AND image_token_reserve IS NULL) OR "
            "(supports_image_input = true AND image_token_reserve > 0)",
            name=op.f("ck_chat_models_image_capability_valid"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_models")),
        sa.UniqueConstraint("key", name=op.f("uq_chat_models_key")),
    )
    op.create_index(
        "ix_chat_models_enabled_sort",
        "chat_models",
        ["enabled", "sort_order", "id"],
        unique=False,
    )

    op.create_table(
        "model_upstreams",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("adapter", sa.String(length=32), nullable=False),
        sa.Column("base_url", sa.String(length=2048), nullable=False),
        sa.Column("api_key_ciphertext", sa.Text(), nullable=False),
        sa.Column("api_key_hint", sa.String(length=32), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "adapter IN ('deepseek', 'openai', 'openrouter')",
            name=op.f("ck_model_upstreams_adapter_valid"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_upstreams")),
        sa.UniqueConstraint("key", name=op.f("uq_model_upstreams_key")),
    )
    op.create_index(
        "ix_model_upstreams_enabled",
        "model_upstreams",
        ["enabled"],
        unique=False,
    )

    op.create_table(
        "model_routes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("chat_model_id", sa.BigInteger(), nullable=False),
        sa.Column("upstream_id", sa.BigInteger(), nullable=False),
        sa.Column("upstream_model", sa.String(length=256), nullable=False),
        sa.Column("priority", sa.Integer(), server_default="100", nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "priority >= 0",
            name=op.f("ck_model_routes_priority_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["chat_model_id"],
            ["chat_models.id"],
            name=op.f("fk_model_routes_chat_model_id_chat_models"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["upstream_id"],
            ["model_upstreams.id"],
            name=op.f("fk_model_routes_upstream_id_model_upstreams"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_routes")),
        sa.UniqueConstraint(
            "chat_model_id",
            "upstream_id",
            "upstream_model",
            name="uq_model_routes_model_upstream_remote_model",
        ),
    )
    op.create_index(
        "ix_model_routes_model_enabled_priority",
        "model_routes",
        ["chat_model_id", "enabled", "priority", "id"],
        unique=False,
    )

    op.add_column(
        "runs",
        sa.Column(
            "model_config_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("runs", "model_config_snapshot")
    op.drop_index("ix_model_routes_model_enabled_priority", table_name="model_routes")
    op.drop_table("model_routes")
    op.drop_index("ix_model_upstreams_enabled", table_name="model_upstreams")
    op.drop_table("model_upstreams")
    op.drop_index("ix_chat_models_enabled_sort", table_name="chat_models")
    op.drop_table("chat_models")
    op.drop_table("model_catalog_state")
    op.alter_column(
        "runs",
        "provider_model",
        existing_type=sa.String(length=256),
        type_=sa.String(length=100),
        existing_nullable=False,
    )
