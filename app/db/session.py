from collections.abc import AsyncIterator, Callable
from functools import lru_cache
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings, get_settings
from app.core.logging import logger

SessionFactory = Callable[[], Any]


def create_engine(
    database_url: str,
    *,
    pool_size: int = 20,
    max_overflow: int = 20,
    pool_timeout: float = 30.0,
) -> AsyncEngine:
    return create_async_engine(
        database_url,
        pool_pre_ping=True,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=pool_timeout,
    )


def create_session_factory(
    database_url: str,
    *,
    pool_size: int = 20,
    max_overflow: int = 20,
    pool_timeout: float = 30.0,
) -> async_sessionmaker[AsyncSession]:
    engine = create_engine(
        database_url,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=pool_timeout,
    )
    return async_sessionmaker(engine, expire_on_commit=False)


def _factory_from_settings(settings: Settings) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(
        settings.database_url,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_timeout=settings.db_pool_timeout_seconds,
    )


@lru_cache
def get_session_factory() -> async_sessionmaker[AsyncSession]:
    return _factory_from_settings(get_settings())


async def get_session() -> AsyncIterator[AsyncSession]:
    async with get_session_factory()() as session:
        yield session


async def check_database_ready(session_factory: SessionFactory | None = None) -> bool:
    factory = session_factory or get_session_factory()
    try:
        async with factory() as session:
            await session.execute(text("select 1"))
    except Exception as exc:
        logger.bind(error=str(exc)).warning("Database readiness check failed")
        return False
    return True
