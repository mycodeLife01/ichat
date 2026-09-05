"""Backfill derived search text in bounded transactions; verify before enabling search."""

import argparse
import asyncio
import time
from typing import Any

from sqlalchemy import func, or_, select, text, true, update
from sqlalchemy.orm import undefer

from app.db.session import get_session_factory
from app.models.conversation import Conversation, Message
from app.services.conversations.search_text import (
    SEARCH_TEXT_VERSION,
    build_title_search_text,
)
from app.services.conversations.search_writes import populate_message_search_text


def _missing(model: Any) -> Any:
    if model is Conversation:
        return or_(
            model.search_text_version.is_distinct_from(SEARCH_TEXT_VERSION),
            model.search_title.is_(None),
        )
    return or_(
        model.search_text_version.is_distinct_from(SEARCH_TEXT_VERSION),
        model.search_text.is_(None),
        model.search_quote_text.is_(None),
        model.search_text_hash.is_(None),
        model.search_quote_hash.is_(None),
    )


async def backfill(
    batch_size: int = 200, start_id: int = 0, rebuild: bool = False
) -> dict[str, int]:
    factory = get_session_factory()
    counts = {"conversations": 0, "messages": 0}
    model: Any
    # Row locks serialize with live writes; derived updates preserve business timestamps.
    for model, label in ((Conversation, "conversations"), (Message, "messages")):
        last_id = start_id
        while True:
            started = time.monotonic()
            async with factory() as session, session.begin():
                rows = list(
                    (
                        await session.scalars(
                            select(model)
                            .options(undefer("*"))
                            .where(model.id > last_id, true() if rebuild else _missing(model))
                            .order_by(model.id)
                            .limit(batch_size)
                            .with_for_update()
                        )
                    ).all()
                )
                if not rows:
                    if last_id != 0 and not rebuild:
                        last_id = 0
                        continue
                    break
                for row in rows:
                    if isinstance(row, Conversation):
                        await session.execute(
                            update(Conversation)
                            .where(Conversation.id == row.id)
                            .values(
                                search_title=build_title_search_text(row.title),
                                search_text_version=SEARCH_TEXT_VERSION,
                                updated_at=row.updated_at,
                            )
                        )
                    else:
                        populate_message_search_text(row)
                    counts[label] += 1
                last_id = rows[-1].id
            print(
                {
                    "table": label,
                    "last_id": last_id,
                    "updated": counts[label],
                    "elapsed_ms": round((time.monotonic() - started) * 1000),
                },
                flush=True,
            )
    return counts


async def verify(batch_size: int = 200) -> dict[str, int]:
    factory = get_session_factory()
    result = {
        "missing_titles": 0,
        "missing_messages": 0,
        "inconsistent_rows": 0,
        "invalid_indexes": 0,
    }
    model: Any
    async with factory() as session:
        for model, key in ((Conversation, "missing_titles"), (Message, "missing_messages")):
            result[key] = (
                await session.scalar(select(func.count()).select_from(model).where(_missing(model)))
                or 0
            )
        valid_indexes = await session.scalar(
            text("""
          SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE i.indisvalid AND n.nspname=current_schema() AND c.relname IN (
            'ix_conversations_search_title','ix_messages_search_body',
            'ix_messages_search_quote','ix_conversations_search_order')
        """)
        )
        result["invalid_indexes"] = 4 - (valid_indexes or 0)
    # Verify every row, including deleted/archived history, without writing any changes.
    for model in (Conversation, Message):
        last_id = 0
        while True:
            async with factory() as session:
                rows = list(
                    (
                        await session.scalars(
                            select(model)
                            .options(undefer("*"))
                            .where(model.id > last_id)
                            .order_by(model.id)
                            .limit(batch_size)
                        )
                    ).all()
                )
                if not rows:
                    break
                for row in rows:
                    if isinstance(row, Conversation):
                        valid = row.search_title == build_title_search_text(row.title)
                    else:
                        expected = Message(
                            role=row.role,
                            content=row.content,
                            metadata_=row.metadata_,
                            reply_quote_excerpt=row.reply_quote_excerpt,
                        )
                        populate_message_search_text(expected)
                        valid = all(
                            getattr(row, field) == getattr(expected, field)
                            for field in (
                                "search_text",
                                "search_quote_text",
                                "search_text_hash",
                                "search_quote_hash",
                            )
                        )
                    result["inconsistent_rows"] += int(not valid)
                last_id = rows[-1].id
    return result


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["backfill", "verify"])
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--start-id", type=int, default=0)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument(
        "--version", type=int, choices=[SEARCH_TEXT_VERSION], default=SEARCH_TEXT_VERSION
    )
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 2000 or args.start_id < 0:
        parser.error("batch-size must be between 1 and 2000; start-id must be nonnegative")
    if args.command == "backfill":
        print(await backfill(args.batch_size, args.start_id, args.rebuild))
    result = await verify(args.batch_size)
    print(result)
    if any(result.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
