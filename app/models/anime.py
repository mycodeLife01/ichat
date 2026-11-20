"""Anime tracking state rows: feeds, releases, downloads, integration health.

PostgreSQL is the source of truth for every step of the pipeline; Celery
messages only wake workers up (see docs/specs/2026-11-18-anime-tracking.md).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from app.db.base import Base

DOWNLOAD_STATUSES = (
    "pending",
    "submitting",
    "running",
    "completed",
    "failed",
    "dead",
    "skipped",
)
NOTIFY_STATUSES = ("none", "pending", "sent", "dead")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


class AnimeFeed(Base):
    __tablename__ = "anime_feeds"
    __table_args__ = (
        CheckConstraint("source IN ('mikan', 'kisssub')", name="source_valid"),
        CheckConstraint("poll_interval_seconds >= 60", name="poll_interval_valid"),
        Index("ix_anime_feeds_enabled_next_poll", "enabled", "next_poll_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    # Treated as a credential: Mikan personal RSS URLs carry a token.
    url: Mapped[str] = mapped_column(Text, nullable=False)
    target_dir: Mapped[str] = mapped_column(Text, nullable=False)
    filters: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    poll_interval_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="600"
    )
    next_poll_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AnimeRelease(Base):
    """One torrent release, identified by infohash. Insert-only."""

    __tablename__ = "anime_releases"
    __table_args__ = (
        CheckConstraint("infohash ~ '^[0-9a-f]{40}$'", name="infohash_valid"),
        CheckConstraint("magnet IS NOT NULL OR torrent_url IS NOT NULL", name="locator_present"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    infohash: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    # Untrusted text from the RSS feed.
    title: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text)
    magnet: Mapped[str | None] = mapped_column(Text)
    torrent_url: Mapped[str | None] = mapped_column(Text)
    # Feed-declared values; size may differ from the real file by ~5%.
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    parsed: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AnimeDownload(Base):
    """Offline-download work unit, one per release (infohash unique)."""

    __tablename__ = "anime_downloads"
    __table_args__ = (
        CheckConstraint(_in("status", DOWNLOAD_STATUSES), name="status_valid"),
        CheckConstraint(_in("notify_status", NOTIFY_STATUSES), name="notify_status_valid"),
        CheckConstraint("origin IN ('feed', 'agent', 'manual')", name="origin_valid"),
        Index("ix_anime_downloads_status_next_attempt", "status", "next_attempt_at"),
        Index("ix_anime_downloads_status_next_check", "status", "next_check_at"),
        Index("ix_anime_downloads_notify_due", "notify_status", "notify_next_attempt_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    public_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        nullable=False,
        unique=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )
    infohash: Mapped[str] = mapped_column(
        String(40),
        ForeignKey("anime_releases.infohash", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    origin: Mapped[str] = mapped_column(String(16), nullable=False)
    feed_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("anime_feeds.id", ondelete="SET NULL"), index=True
    )
    proposal_id: Mapped[int | None] = mapped_column(BigInteger)
    # Relative to the OpenList user's base path; fixed at creation time.
    target_dir: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    skip_reason: Mapped[str | None] = mapped_column(String(64))
    # Opaque CloudTaskRef interpreted only by the drive adapter.
    cloud_task: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    file_paths: Mapped[list[str] | None] = mapped_column(JSONB)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lease_owner: Mapped[str | None] = mapped_column(String(255))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    # Running rows only: next cloud check, doubling as the check-chain version.
    next_check_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # First claim ever (kept across retries): lower bound for matching files,
    # since an attempt whose outcome was unknown may have created the task.
    first_claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Entered running: start of the adaptive check schedule.
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notify_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="none")
    notify_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    notify_next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notify_lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AnimeIntegrationState(Base):
    """Health of one monitored object (``drive`` or ``feed:{id}``).

    ``status`` and ``alerted_status`` are separate so a state change is never
    assumed to have been announced.
    """

    __tablename__ = "anime_integration_state"
    __table_args__ = (
        CheckConstraint("status IN ('ok', 'down', 'failing')", name="status_valid"),
        CheckConstraint("alerted_status IN ('ok', 'down', 'failing')", name="alerted_status_valid"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    since: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text)
    alerted_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="ok")
    alert_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_alert_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
