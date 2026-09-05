"""Account-scoped history search with bounded summaries and signed keyset cursors."""

import base64
import hashlib
import hmac
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.user import User
from app.schemas.conversation_search import (
    ConversationSearchItem,
    ConversationSearchResponse,
    SearchRange,
    SearchSnippet,
    SearchTarget,
)
from app.services.conversations.search_text import normalize_query, title_match_range, utf16_length

_CURSOR_PURPOSE = b"ichat:conversation-search:cursor:v1\0"


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _decode(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)


def _sign(payload: bytes, secret: str) -> bytes:
    return hmac.digest(secret.encode(), _CURSOR_PURPOSE + payload, "sha256")


def _account_binding(user_id: int, secret: str) -> str:
    return hmac.digest(secret.encode(), f"search-account:{user_id}".encode(), "sha256").hex()


def _query_fingerprint(query: str) -> str:
    return hashlib.sha256(query.encode()).hexdigest()


def _cursor(payload: dict[str, Any], secret: str) -> str:
    data = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return _encode(data) + "." + _encode(_sign(data, secret))


def _read_cursor(
    cursor: str, *, user_id: int, query: str, limit: int, secret: str
) -> dict[str, Any]:
    try:
        if len(cursor) > 2048:
            raise ValueError
        encoded, signed = cursor.split(".")
        data, signature = _decode(encoded), _decode(signed)
        if not hmac.compare_digest(_sign(data, secret), signature):
            raise ValueError
        payload = json.loads(data)
        if (payload["v"], payload["u"], payload["q"], payload["n"]) != (
            1,
            _account_binding(user_id, secret),
            _query_fingerprint(query),
            limit,
        ):
            raise ValueError
        UUID(payload["id"])
        moment = datetime.fromisoformat(payload["t"])
        if moment.tzinfo is None:
            raise ValueError
        return dict(payload)
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise AppError(400, "Invalid search cursor.", code="search_cursor_invalid") from None


_QUERY = """
WITH matched AS (
  SELECT c.id FROM conversations c
  WHERE c.user_id=:owner AND c.deleted_at IS NULL AND c.activated_at IS NOT NULL
    AND c.search_text_version=1
    AND search_normalize(c.search_title) COLLATE "C" LIKE :pattern ESCAPE '\\'
  UNION
  SELECT m.conversation_id FROM messages m
  JOIN conversations c ON c.id=m.conversation_id
  WHERE c.user_id=:owner AND c.deleted_at IS NULL AND c.activated_at IS NOT NULL
    AND m.archived_at IS NULL AND m.search_text_version=1
    AND (search_normalize(m.search_text) COLLATE "C" LIKE :pattern ESCAPE '\\'
      OR search_normalize(m.search_quote_text) COLLATE "C" LIKE :pattern ESCAPE '\\')
), page AS (
  SELECT c.id,c.public_id,c.title,c.updated_at FROM conversations c JOIN matched x ON x.id=c.id
  WHERE (:after_time IS NULL OR (c.updated_at,c.id)<(:after_time,:after_id))
  ORDER BY c.updated_at DESC,c.id DESC LIMIT :take
)
SELECT p.public_id,p.title,p.updated_at,hit.public_id AS message_id,hit.field,hit.hash,
  search_utf16_length(left(hit.body,loc.pos-1)) AS match_start,
  search_utf16_length(:query) AS match_length,
  substring(hit.body FROM greatest(1,loc.pos-40)
      FOR :query_length+40+least(40,loc.pos-1)) AS snippet,
  search_utf16_length(substring(hit.body FROM greatest(1,loc.pos-40)
      FOR loc.pos-greatest(1,loc.pos-40))) AS snippet_start,
  loc.pos>41 AS truncated_before,
  length(hit.body)>loc.pos+:query_length+39 AS truncated_after
FROM page p
LEFT JOIN LATERAL (
  SELECT m.public_id,
    CASE WHEN search_normalize(m.search_text) COLLATE "C" LIKE :pattern ESCAPE '\\'
      THEN 'body' ELSE 'reply_quote' END AS field,
    CASE WHEN search_normalize(m.search_text) COLLATE "C" LIKE :pattern ESCAPE '\\'
      THEN m.search_text ELSE m.search_quote_text END AS body,
    CASE WHEN search_normalize(m.search_text) COLLATE "C" LIKE :pattern ESCAPE '\\'
      THEN m.search_text_hash ELSE m.search_quote_hash END AS hash
  FROM messages m WHERE m.conversation_id=p.id AND m.archived_at IS NULL
    AND m.search_text_version=1
    AND (search_normalize(m.search_text) COLLATE "C" LIKE :pattern ESCAPE '\\'
      OR search_normalize(m.search_quote_text) COLLATE "C" LIKE :pattern ESCAPE '\\')
  ORDER BY m.position DESC LIMIT 1
) hit ON true
LEFT JOIN LATERAL (SELECT strpos(search_normalize(hit.body),:query) AS pos) loc ON true
ORDER BY p.updated_at DESC,p.id DESC
"""


_CANDIDATE_QUERY = _QUERY
_QUERY = (
    """
WITH page AS (
  SELECT c.id,c.public_id,c.title,c.updated_at FROM conversations c
  WHERE c.user_id=:owner AND c.deleted_at IS NULL AND c.activated_at IS NOT NULL
    AND (CAST(:after_time AS timestamptz) IS NULL OR (c.updated_at,c.id)<(:after_time,:after_id))
    AND ((c.search_text_version=1
          AND search_normalize(c.search_title) COLLATE "C" LIKE :pattern ESCAPE '\\')
      OR EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id=c.id
          AND m.archived_at IS NULL AND m.search_text_version=1
          AND (search_normalize(m.search_text) COLLATE "C" LIKE :pattern ESCAPE '\\'
            OR search_normalize(m.search_quote_text) COLLATE "C" LIKE :pattern ESCAPE '\\')
        OFFSET 0
      ))
  ORDER BY c.updated_at DESC,c.id DESC LIMIT :take
)
"""
    + "SELECT p.public_id"
    + _CANDIDATE_QUERY.split("SELECT p.public_id", 1)[1]
)


async def search_conversations(
    session: AsyncSession,
    *,
    user: User,
    query: str,
    limit: int = 30,
    cursor: str | None = None,
    secret: str,
) -> ConversationSearchResponse:
    if len(query) > 200 or "\x00" in query or not 1 <= limit <= 50:
        raise AppError(422, "Search query or page size is invalid.", code="search_query_invalid")
    query = normalize_query(query)
    if not query:
        if cursor:
            raise AppError(400, "Invalid search cursor.", code="search_cursor_invalid")
        rows = (
            (
                await session.execute(
                    text("""
            SELECT public_id,title,updated_at FROM conversations
            WHERE user_id=:owner AND deleted_at IS NULL AND activated_at IS NOT NULL
            ORDER BY updated_at DESC,id DESC LIMIT 10
        """),
                    {"owner": user.id},
                )
            )
            .mappings()
            .all()
        )
        return ConversationSearchResponse(
            items=[
                ConversationSearchItem(
                    conversation_id=r["public_id"], title=r["title"], updated_at=r["updated_at"]
                )
                for r in rows
            ]
        )
    after_time, after_id = None, None
    if cursor:
        boundary = _read_cursor(cursor, user_id=user.id, query=query, limit=limit, secret=secret)
        after_time = datetime.fromisoformat(boundary["t"])
        after_id = await session.scalar(
            text("SELECT id FROM conversations WHERE public_id=:id AND user_id=:owner"),
            {"id": UUID(boundary["id"]), "owner": user.id},
        )
        if after_id is None:
            raise AppError(400, "Invalid search cursor.", code="search_cursor_invalid")
    pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    params = {
        "owner": user.id,
        "query": query,
        "query_length": len(query),
        "pattern": pattern,
        "take": limit + 1,
        "after_time": after_time,
        "after_id": after_id,
    }
    # A savepoint ensures statement_timeout cannot poison the caller's transaction.
    try:
        async with session.begin_nested():
            previous = await session.scalar(text("SHOW statement_timeout"))
            await session.execute(text("SELECT set_config('statement_timeout','2000',true)"))
            rows = (
                (
                    await session.execute(
                        text(
                            _QUERY.replace(
                                ":after_time IS NULL", "CAST(:after_time AS timestamptz) IS NULL"
                            )
                        ),
                        params,
                    )
                )
                .mappings()
                .all()
            )
            await session.execute(
                text("SELECT set_config('statement_timeout',:value,true)"), {"value": previous}
            )
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) == "57014":
            raise AppError(503, "Search timed out. Please retry.", code="search_timeout") from None
        raise AppError(503, "Search unavailable. Please retry.", code="search_failed") from None
    items = []
    for row in rows[:limit]:
        item = ConversationSearchItem(
            conversation_id=row["public_id"], title=row["title"], updated_at=row["updated_at"]
        )
        match = title_match_range(row["title"] or "", query)
        if match:
            item.title_match = SearchRange(start=match[0], end=match[1])
        if row["message_id"] is not None:
            item.target = SearchTarget(
                message_id=row["message_id"],
                field=row["field"],
                projection_hash=row["hash"],
                start=row["match_start"],
                end=row["match_start"] + row["match_length"],
            )
            item.snippet = SearchSnippet(
                text=row["snippet"],
                match=SearchRange(
                    start=row["snippet_start"], end=row["snippet_start"] + utf16_length(query)
                ),
                truncated_before=row["truncated_before"],
                truncated_after=row["truncated_after"],
            )
        items.append(item)
    next_cursor = None
    if len(rows) > limit:
        last = items[-1]
        next_cursor = _cursor(
            {
                "v": 1,
                "u": _account_binding(user.id, secret),
                "q": _query_fingerprint(query),
                "n": limit,
                "t": last.updated_at.isoformat(),
                "id": str(last.conversation_id),
            },
            secret,
        )
    return ConversationSearchResponse(items=items, next_cursor=next_cursor)
