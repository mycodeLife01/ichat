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

from app.core.config import get_settings
from app.core.logging import logger

SessionFactory = Callable[[], Any]


def create_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(database_url, pool_pre_ping=True)


def create_session_factory(database_url: str) -> async_sessionmaker[AsyncSession]:
    engine = create_engine(database_url)
    return async_sessionmaker(engine, expire_on_commit=False)


@lru_cache
def get_session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(get_settings().database_url)


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
