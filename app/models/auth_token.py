from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from app.db.base import Base


class AuthToken(Base):
    """General-purpose, single-use authentication token.

    Replaces the legacy ``email_verification_tokens`` table. ``purpose``
    distinguishes use cases (only ``email_verification`` is implemented now;
    ``password_reset`` / ``account_deletion`` are reserved). Only the SHA-256
    hex digest of the raw token is stored.
    """

    __tablename__ = "auth_tokens"
    __table_args__ = (
        Index("ix_auth_tokens_user_purpose", "user_id", "purpose"),
        Index("ix_auth_tokens_expires_at", "expires_at"),
        # Backstop for concurrent issuance: at most one active token per
        # (user, purpose). The service layer revokes the old active token
        # before creating a new one; this index catches races.
        Index(
            "uq_auth_tokens_active_purpose",
            "user_id",
            "purpose",
            unique=True,
            postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    purpose: Mapped[str] = mapped_column(String(64), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    sent_to_email: Mapped[str] = mapped_column(String(254), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
