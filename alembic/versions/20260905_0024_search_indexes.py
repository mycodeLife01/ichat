"""Add online indexes for literal conversation search."""

from sqlalchemy import text

from alembic import op

revision = "20260905_0024"
down_revision = "20260905_0023"
branch_labels = None
depends_on = None

INDEXES = {
    "ix_conversations_search_title": (
        'ON conversations USING gin ((search_normalize(search_title) COLLATE "C") gin_trgm_ops) '
        "WHERE deleted_at IS NULL AND activated_at IS NOT NULL"
    ),
    "ix_messages_search_body": (
        'ON messages USING gin ((search_normalize(search_text) COLLATE "C") gin_trgm_ops) '
        "WHERE archived_at IS NULL"
    ),
    "ix_messages_search_quote": (
        'ON messages USING gin ((search_normalize(search_quote_text) COLLATE "C") gin_trgm_ops) '
        "WHERE archived_at IS NULL"
    ),
    "ix_conversations_search_order": (
        "ON conversations (user_id, updated_at DESC, id DESC) "
        "WHERE deleted_at IS NULL AND activated_at IS NOT NULL"
    ),
}


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    with op.get_context().autocommit_block():
        for name, expression in INDEXES.items():
            valid = op.get_bind().scalar(
                text("""
                SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE c.relname=:name AND n.nspname=current_schema()
            """),
                {"name": name},
            )
            if valid is False:
                op.execute(f"DROP INDEX CONCURRENTLY {name}")
            op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} {expression}")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name in INDEXES:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
