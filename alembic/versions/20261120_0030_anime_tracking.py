"""Add anime tracking tables.

Creates ``anime_feeds``, ``anime_releases``, ``anime_downloads`` and
``anime_integration_state`` for the P0 pipeline (Mikan RSS -> OpenList ->
Telegram). Purely additive; downgrade drops the four tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "20261120_0030"
down_revision: str | None = "20261028_0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "anime_feeds",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("target_dir", sa.Text(), nullable=False),
        sa.Column("filters", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("poll_interval_seconds", sa.Integer(), server_default="600", nullable=False),
        sa.Column("next_poll_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.Column("last_polled_at", _TS, nullable=True),
        sa.Column("lease_expires_at", _TS, nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("source IN ('mikan', 'kisssub')", name="source_valid"),
        sa.CheckConstraint("poll_interval_seconds >= 60", name="poll_interval_valid"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_anime_feeds")),
        sa.UniqueConstraint("name", name=op.f("uq_anime_feeds_name")),
    )
    op.create_index("ix_anime_feeds_enabled_next_poll", "anime_feeds", ["enabled", "next_poll_at"])

    op.create_table(
        "anime_releases",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("infohash", sa.String(length=40), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("magnet", sa.Text(), nullable=True),
        sa.Column("torrent_url", sa.Text(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("published_at", _TS, nullable=True),
        sa.Column("parsed", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("first_seen_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("infohash ~ '^[0-9a-f]{40}$'", name="infohash_valid"),
        sa.CheckConstraint("magnet IS NOT NULL OR torrent_url IS NOT NULL", name="locator_present"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_anime_releases")),
        sa.UniqueConstraint("infohash", name=op.f("uq_anime_releases_infohash")),
    )

    op.create_table(
        "anime_downloads",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "public_id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("infohash", sa.String(length=40), nullable=False),
        sa.Column("origin", sa.String(length=16), nullable=False),
        sa.Column("feed_id", sa.BigInteger(), nullable=True),
        sa.Column("proposal_id", sa.BigInteger(), nullable=True),
        sa.Column("target_dir", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("skip_reason", sa.String(length=64), nullable=True),
        sa.Column("cloud_task", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("file_paths", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_attempt_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.Column("lease_owner", sa.String(length=255), nullable=True),
        sa.Column("lease_expires_at", _TS, nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_check_at", _TS, nullable=True),
        sa.Column("first_claimed_at", _TS, nullable=True),
        sa.Column("submitted_at", _TS, nullable=True),
        sa.Column("completed_at", _TS, nullable=True),
        sa.Column("notify_status", sa.String(length=16), server_default="none", nullable=False),
        sa.Column("notify_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("notify_next_attempt_at", _TS, nullable=True),
        sa.Column("notify_lease_expires_at", _TS, nullable=True),
        sa.Column("notified_at", _TS, nullable=True),
        sa.Column("created_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending', 'submitting', 'running', 'completed', 'failed', "
            "'dead', 'skipped')",
            name="status_valid",
        ),
        sa.CheckConstraint(
            "notify_status IN ('none', 'pending', 'sent', 'dead')", name="notify_status_valid"
        ),
        sa.CheckConstraint("origin IN ('feed', 'agent', 'manual')", name="origin_valid"),
        sa.ForeignKeyConstraint(
            ["feed_id"],
            ["anime_feeds.id"],
            name=op.f("fk_anime_downloads_feed_id_anime_feeds"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["infohash"],
            ["anime_releases.infohash"],
            name=op.f("fk_anime_downloads_infohash_anime_releases"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_anime_downloads")),
        sa.UniqueConstraint("infohash", name=op.f("uq_anime_downloads_infohash")),
        sa.UniqueConstraint("public_id", name=op.f("uq_anime_downloads_public_id")),
    )
    op.create_index(op.f("ix_anime_downloads_feed_id"), "anime_downloads", ["feed_id"])
    op.create_index(
        "ix_anime_downloads_status_next_attempt", "anime_downloads", ["status", "next_attempt_at"]
    )
    op.create_index(
        "ix_anime_downloads_status_next_check", "anime_downloads", ["status", "next_check_at"]
    )
    op.create_index(
        "ix_anime_downloads_notify_due",
        "anime_downloads",
        ["notify_status", "notify_next_attempt_at"],
    )

    op.create_table(
        "anime_integration_state",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("since", _TS, nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("alerted_status", sa.String(length=16), server_default="ok", nullable=False),
        sa.Column("alert_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_alert_at", _TS, nullable=True),
        sa.Column("updated_at", _TS, server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("status IN ('ok', 'down', 'failing')", name="status_valid"),
        sa.CheckConstraint(
            "alerted_status IN ('ok', 'down', 'failing')", name="alerted_status_valid"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_anime_integration_state")),
        sa.UniqueConstraint("key", name=op.f("uq_anime_integration_state_key")),
    )


def downgrade() -> None:
    op.drop_table("anime_integration_state")
    op.drop_index("ix_anime_downloads_notify_due", table_name="anime_downloads")
    op.drop_index("ix_anime_downloads_status_next_check", table_name="anime_downloads")
    op.drop_index("ix_anime_downloads_status_next_attempt", table_name="anime_downloads")
    op.drop_index(op.f("ix_anime_downloads_feed_id"), table_name="anime_downloads")
    op.drop_table("anime_downloads")
    op.drop_table("anime_releases")
    op.drop_index("ix_anime_feeds_enabled_next_poll", table_name="anime_feeds")
    op.drop_table("anime_feeds")
