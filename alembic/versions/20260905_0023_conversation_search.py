"""Add rebuildable history search text and Unicode position helpers."""

import sqlalchemy as sa

from alembic import op

revision = "20260905_0023"
down_revision = "20260905_0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("conversations", sa.Column("search_title", sa.Text(), nullable=True))
    op.add_column(
        "conversations", sa.Column("search_text_version", sa.SmallInteger(), nullable=True)
    )
    for name in ("search_text", "search_quote_text"):
        op.add_column("messages", sa.Column(name, sa.Text(), nullable=True))
    for name in ("search_text_hash", "search_quote_hash"):
        op.add_column("messages", sa.Column(name, sa.String(64), nullable=True))
    op.add_column("messages", sa.Column("search_text_version", sa.SmallInteger(), nullable=True))
    op.execute("""
        CREATE FUNCTION search_utf16_length(value text) RETURNS integer
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
          SELECT length(value) + regexp_count(value COLLATE \"C\", '[𐀀-􏿿]')
        $$
    """)
    op.execute("""
        CREATE FUNCTION search_normalize(value text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
          SELECT lower(value COLLATE \"C\")
        $$
    """)


def downgrade() -> None:
    op.execute("DROP FUNCTION search_normalize(text)")
    op.execute("DROP FUNCTION search_utf16_length(text)")
    for name in (
        "search_text",
        "search_quote_text",
        "search_text_version",
        "search_text_hash",
        "search_quote_hash",
    ):
        op.drop_column("messages", name)
    op.drop_column("conversations", "search_title")
    op.drop_column("conversations", "search_text_version")
