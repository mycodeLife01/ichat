from datetime import datetime

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
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class ModelCatalogState(Base):
    __tablename__ = "model_catalog_state"
    __table_args__ = (CheckConstraint("id = 1", name="singleton"),)

    id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        default=1,
        server_default="1",
    )
    database_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class ChatModel(Base):
    __tablename__ = "chat_models"
    __table_args__ = (
        CheckConstraint("sort_order >= 0", name="sort_order_non_negative"),
        CheckConstraint(
            "token_profile IN ('default', 'deepseek', 'openai')",
            name="token_profile_valid",
        ),
        CheckConstraint(
            "jsonb_typeof(thinking_levels) = 'array'",
            name="thinking_levels_array",
        ),
        CheckConstraint(
            "(supports_image_input = false AND image_token_reserve IS NULL) OR "
            "(supports_image_input = true AND image_token_reserve > 0)",
            name="image_capability_valid",
        ),
        Index("ix_chat_models_enabled_sort", "enabled", "sort_order", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="100")
    thinking_levels: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default="[]",
    )
    supports_image_input: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    image_token_reserve: Mapped[int | None] = mapped_column(Integer, nullable=True)
    token_profile: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="default",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class ModelUpstream(Base):
    __tablename__ = "model_upstreams"
    __table_args__ = (
        CheckConstraint(
            "adapter IN ('deepseek', 'openai', 'openrouter')",
            name="adapter_valid",
        ),
        Index("ix_model_upstreams_enabled", "enabled"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    adapter: Mapped[str] = mapped_column(String(32), nullable=False)
    base_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    api_key_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    api_key_hint: Mapped[str] = mapped_column(String(32), nullable=False)
    enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class ModelRoute(Base):
    __tablename__ = "model_routes"
    __table_args__ = (
        CheckConstraint("priority >= 0", name="priority_non_negative"),
        CheckConstraint(
            "reasoning_outputs IN ("
            "'[]'::jsonb, '[\"raw\"]'::jsonb, '[\"summary\"]'::jsonb, "
            "'[\"raw\", \"summary\"]'::jsonb, "
            "'[\"summary\", \"raw\"]'::jsonb"
            ")",
            name="reasoning_outputs_valid",
        ),
        UniqueConstraint(
            "chat_model_id",
            "upstream_id",
            "upstream_model",
            name="uq_model_routes_model_upstream_remote_model",
        ),
        Index(
            "ix_model_routes_model_enabled_priority",
            "chat_model_id",
            "enabled",
            "priority",
            "id",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    chat_model_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chat_models.id", ondelete="CASCADE"),
        nullable=False,
    )
    upstream_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("model_upstreams.id", ondelete="RESTRICT"),
        nullable=False,
    )
    upstream_model: Mapped[str] = mapped_column(String(256), nullable=False)
    reasoning_outputs: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default="[]",
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, server_default="100")
    enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
