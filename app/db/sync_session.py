"""Synchronous SQLAlchemy engine for the Celery email worker.

The API runs on async SQLAlchemy (asyncpg); Celery is a synchronous process,
so it uses an independent sync engine (psycopg) over the same database. We do
NOT run async sessions via ``asyncio.run`` inside tasks (per-task event loops
bound to asyncpg are fragile). The sync URL is derived from ``DATABASE_URL`` by
swapping the driver, so no extra connection string config is needed.
"""

from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, get_settings


def sync_database_url(async_url: str) -> str:
    return async_url.replace("+asyncpg", "+psycopg")


def create_sync_engine(settings: Settings) -> Engine:
    # Small pool: each Celery worker process holds its own. Counts toward
    # PostgreSQL max_connections budget alongside the API and LLM workers.
    return create_engine(
        sync_database_url(settings.database_url),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
    )


@lru_cache
def get_sync_session_factory() -> sessionmaker[Session]:
    engine = create_sync_engine(get_settings())
    return sessionmaker(engine, expire_on_commit=False)
