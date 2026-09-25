"""Allow the GLM upstream adapter."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260921_0025"
down_revision: str | None = "20260905_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("ck_model_upstreams_adapter_valid"),
        "model_upstreams",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_model_upstreams_adapter_valid"),
        "model_upstreams",
        "adapter IN ('deepseek', 'openai', 'openrouter', 'glm')",
    )


def downgrade() -> None:
    glm_upstreams = op.get_bind().execute(
        sa.text("SELECT count(*) FROM model_upstreams WHERE adapter = 'glm'")
    ).scalar_one()
    if glm_upstreams:
        raise RuntimeError("Refusing to downgrade while GLM model upstreams still exist")
    op.drop_constraint(
        op.f("ck_model_upstreams_adapter_valid"),
        "model_upstreams",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_model_upstreams_adapter_valid"),
        "model_upstreams",
        "adapter IN ('deepseek', 'openai', 'openrouter')",
    )
