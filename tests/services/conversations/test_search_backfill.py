from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.orm import undefer

from app import conversation_search_admin as admin
from app.models.conversation import Conversation, Message
from tests.services.conversations.test_search import db, user  # noqa: F401


async def test_backfill_is_complete_idempotent_and_preserves_order(db, monkeypatch):  # noqa: F811
    owner = await user(db)
    before = datetime(2020, 1, 2, tzinfo=UTC)
    c = Conversation(
        user_id=owner.id,
        title="历史标题",
        updated_at=before,
        activated_at=before,
        deleted_at=before,
    )
    db.add(c)
    await db.flush()
    m = Message(
        conversation_id=c.id,
        position=1,
        role="assistant",
        content="历史 **正文**",
        archived_at=before,
    )
    db.add(m)
    await db.flush()
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    monkeypatch.setattr(admin, "get_session_factory", lambda: factory)
    first = await admin.backfill(1)
    assert first["conversations"] >= 1 and first["messages"] >= 1
    assert await admin.verify() == {
        "missing_titles": 0,
        "missing_messages": 0,
        "inconsistent_rows": 0,
        "invalid_indexes": 0,
    }
    assert await admin.backfill(1) == {"conversations": 0, "messages": 0}
    conversation_id = c.id
    db.expire_all()
    loaded = await db.scalar(
        select(Conversation).options(undefer("*")).where(Conversation.id == conversation_id)
    )
    assert loaded.updated_at == before and loaded.search_title == "历史标题"
