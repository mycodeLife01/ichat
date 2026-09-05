import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.user import User
from app.services.conversations.search import search_conversations
from app.services.conversations.search_text import build_title_search_text, search_text_hash
from app.services.conversations.search_writes import populate_message_search_text


@pytest.fixture
async def db():
    engine = create_async_engine(os.environ["DATABASE_URL"], hide_parameters=True)
    async with engine.connect() as conn:
        transaction = await conn.begin()
        factory = async_sessionmaker(conn, expire_on_commit=False)
        async with factory() as session:
            yield session
        await transaction.rollback()
    await engine.dispose()


async def user(db):
    name = uuid.uuid4().hex
    value = User(username=name, email=f"{name}@search-test.example", password_hash="unused")
    db.add(value)
    await db.flush()
    return value


async def chat(
    db,
    owner,
    *,
    title="对话",
    body="内容",
    quote=None,
    age=0,
    archived=False,
    deleted=False,
    active=True,
):
    now = datetime.now(UTC) - timedelta(days=age)
    c = Conversation(
        user_id=owner.id,
        title=title,
        search_title=build_title_search_text(title),
        search_text_version=1,
        updated_at=now,
        activated_at=now if active else None,
        deleted_at=now if deleted else None,
    )
    db.add(c)
    await db.flush()
    m = Message(
        conversation_id=c.id,
        content=body,
        role="user",
        position=1,
        reply_quote_excerpt=quote,
        archived_at=now if archived else None,
    )
    populate_message_search_text(m)
    db.add(m)
    await db.flush()
    return c, m


async def search(db, owner, query, **kwargs):
    return await search_conversations(db, user=owner, query=query, secret="test-secret", **kwargs)


async def test_filter_rank_and_targets(db):
    owner, other = await user(db), await user(db)
    old, _ = await chat(db, owner, title="搜索标题", body="无", age=20)
    recent, message = await chat(db, owner, body="😀正文搜索 ABC")
    await chat(db, other, body="搜索")
    await chat(db, owner, body="搜索", archived=True)
    await chat(db, owner, body="搜索", deleted=True)
    await chat(db, owner, body="搜索", active=False)
    result = await search(db, owner, "搜索")
    assert [row.conversation_id for row in result.items] == [recent.public_id, old.public_id]
    target = result.items[0].target
    assert target.message_id == message.public_id
    assert (target.start, target.end) == (4, 6)
    assert target.projection_hash == search_text_hash(message.search_text)
    assert result.items[1].target is None
    assert result.items[1].snippet is None


async def test_literal_pagination_and_cursor_binding(db):
    owner, other = await user(db), await user(db)
    chats = [await chat(db, owner, body="100% foo_bar \\ 中文 😀 ABC", age=i) for i in range(5)]
    for term in ["%", "_", "\\", "中", "中文", "😀", "abc"]:
        result = await search(db, owner, term, limit=2)
        assert len(result.items) == 2 and result.next_cursor
    first = await search(db, owner, "中文", limit=2)
    second = await search(db, owner, "中文", limit=2, cursor=first.next_cursor)
    third = await search(db, owner, "中文", limit=2, cursor=second.next_cursor)
    assert [x.conversation_id for x in first.items + second.items + third.items] == [
        x[0].public_id for x in chats
    ]
    assert third.next_cursor is None
    for who, term, cursor, limit in [
        (other, "中文", first.next_cursor, 2),
        (owner, "中", first.next_cursor, 2),
        (owner, "中文", first.next_cursor + "x", 2),
        (owner, "中文", first.next_cursor, 3),
    ]:
        with pytest.raises(AppError, match="Invalid search cursor"):
            await search(db, who, term, cursor=cursor, limit=limit)


async def test_latest_message_and_quote_precedence(db):
    owner = await user(db)
    c, _ = await chat(db, owner, body="needle first")
    last = Message(
        conversation_id=c.id,
        position=2,
        role="user",
        content="plain",
        reply_quote_excerpt="😀 quote needle",
    )
    populate_message_search_text(last)
    db.add(last)
    await db.flush()
    item = (await search(db, owner, "needle")).items[0]
    assert item.target.field == "reply_quote" and item.target.message_id == last.public_id
    last.content = "body needle"
    populate_message_search_text(last)
    await db.flush()
    assert (await search(db, owner, "needle")).items[0].target.field == "body"


async def test_sql_utf16_and_query_validation(db):
    assert await db.scalar(text("SELECT search_utf16_length('😀𐀀中文')")) == 6
    owner = await user(db)
    for query in ["x" * 201, "\x00"]:
        with pytest.raises(AppError):
            await search(db, owner, query)
    assert (await search(db, owner, " \t")).items == []


async def test_timeout_rolls_back_savepoint_and_does_not_leak_query(db, monkeypatch):
    from app.services.conversations import search as module

    owner = await user(db)
    monkeypatch.setattr(module, "_QUERY", "SELECT pg_sleep(3)")
    with pytest.raises(AppError) as caught:
        await search(db, owner, "private-query")
    assert caught.value.code == "search_timeout"
    assert "private-query" not in str(caught.value)
    assert await db.scalar(text("SELECT 1")) == 1
    assert await db.scalar(text("SHOW statement_timeout")) == "0"


async def test_equal_timestamps_deduplicate_before_paging_and_bound_snippet(db):
    owner = await user(db)
    first, _ = await chat(db, owner, body="命中" + "文" * 200)
    second, _ = await chat(db, owner, title="命中", body="命中")
    second.updated_at = first.updated_at
    await db.flush()
    page = await search(db, owner, "命中", limit=1)
    assert page.items[0].conversation_id == second.public_id
    following = await search(db, owner, "命中", limit=1, cursor=page.next_cursor)
    assert following.items[0].conversation_id == first.public_id
    assert len(following.items[0].snippet.text) == 42
    assert following.items[0].snippet.truncated_after
    assert following.next_cursor is None
