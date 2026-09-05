"""Reproducible search benchmark. Refuses all databases except *_search_perf."""

import argparse
import asyncio
import json
import os
import platform
import statistics
import time
from pathlib import Path

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.models.user import User
from app.services.auth.dependencies import get_current_user
from app.services.conversations.search import _QUERY

QUERIES = {
    "single": "的",
    "double": "搜索",
    "phrase": "历史对话中的中文搜索",
    "common": "记录",
    "rare": "独特菠萝",
    "absent": "绝无匹配哨兵",
    "percent": "%",
    "underscore": "_",
    "backslash": "\\",
    "emoji": "😀",
    "title_only": "标题专属",
    "english": "postgresql",
}


async def seed(factory, name: str, conversations: int) -> None:
    async with factory() as session, session.begin():
        if await session.scalar(select(User.id).where(User.username == name)):
            raise SystemExit("Account already exists; use a new fixture name.")
        owner = User(username=name, email=f"{name}@benchmark.invalid", password_hash="unusable")
        session.add(owner)
        await session.flush()
        await session.execute(
            text("""
          INSERT INTO conversations
            (user_id,title,search_title,search_text_version,activated_at,updated_at)
          SELECT :owner, '标题专属 '||n, '标题专属 '||n, 1, now(), now()-n*interval '1 minute'
          FROM generate_series(1,:count) n
        """),
            {"owner": owner.id, "count": conversations},
        )
        await session.execute(
            text("""
          INSERT INTO messages (conversation_id,position,role,content,search_text,search_quote_text,
                                search_text_version,search_text_hash,search_quote_hash)
          SELECT id,n,CASE WHEN n%2=0 THEN 'assistant' ELSE 'user' END,
            body,body,quote,1,
            encode(sha256(convert_to('conversation-search:1'||chr(10)||body,'UTF8')),'hex'),
            encode(sha256(convert_to('conversation-search:1'||chr(10)||quote,'UTF8')),'hex')
          FROM (
            SELECT c.id,n,repeat(
              '这是历史对话中的中文搜索记录，包含需求讨论、产品设计和数据分页。 ',8)
              || 'PostgreSQL 😀 100% foo_bar C:\\docs '
              || CASE WHEN c.id%97=0 AND n=1 THEN '独特菠萝' ELSE '' END AS body,
              CASE WHEN n%2=1 THEN repeat('引用记录的历史快照 ',4) ELSE '' END AS quote
            FROM conversations c CROSS JOIN generate_series(1,20) n WHERE c.user_id=:owner
          ) rows
        """),
            {"owner": owner.id},
        )
    async with factory() as session:
        await session.execute(text("ANALYZE conversations"))
        await session.execute(text("ANALYZE messages"))
        await session.commit()
    print(
        json.dumps({"seeded": name, "conversations": conversations, "messages": conversations * 20})
    )


async def bench(factory, name, repeat, concurrency, output):
    async with factory() as session:
        owner = await session.scalar(select(User).where(User.username == name))
        version = await session.scalar(text("SELECT version()"))
        size = (
            await session.execute(
                text("""SELECT count(*),avg(octet_length(content)),
          max(octet_length(content)), pg_total_relation_size('messages') FROM messages""")
            )
        ).one()
    if not owner:
        raise SystemExit("Seed the requested fixture account first.")
    app = create_app()
    settings = get_settings().model_copy(update={"conversation_search_enabled": True})
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_current_user] = lambda: owner

    async def db():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = db
    result = {
        "host": platform.platform(),
        "postgres": version,
        "global_messages": size[0],
        "mean_message_bytes": float(size[1]),
        "max_message_bytes": size[2],
        "message_table_and_indexes_bytes": size[3],
        "account": name,
        "samples": repeat,
        "queries": {},
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://benchmark") as client:
        for label, query in QUERIES.items():
            report = {}
            started = time.perf_counter()
            await client.get("/api/v1/conversations/search", params={"q": query})
            report["first_request_ms"] = round((time.perf_counter() - started) * 1000, 2)
            for parallel in concurrency:
                semaphore = asyncio.Semaphore(parallel)

                async def request(semaphore=semaphore, query=query):
                    async with semaphore:
                        started = time.perf_counter()
                        response = await client.get(
                            "/api/v1/conversations/search", params={"q": query}
                        )
                        return (
                            (time.perf_counter() - started) * 1000,
                            response.status_code,
                            len(response.content),
                        )

                samples = await asyncio.gather(*(request() for _ in range(repeat)))
                timings = sorted(row[0] for row in samples)
                report[str(parallel)] = {
                    "p50": round(statistics.median(timings), 2),
                    "p95": round(timings[int(len(timings) * 0.95) - 1], 2),
                    "p99": round(timings[int(len(timings) * 0.99) - 1], 2),
                    "errors": sum(row[1] != 200 for row in samples),
                    "max_bytes": max(row[2] for row in samples),
                }
            result["queries"][label] = report
            print(json.dumps({label: report}), flush=True)
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    async with factory() as session:
        plan = await session.scalar(
            text(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
                + _QUERY.replace(":after_time IS NULL", "CAST(:after_time AS timestamptz) IS NULL")
            ),
            {
                "owner": owner.id,
                "pattern": "%搜索%",
                "query": "搜索",
                "query_length": 2,
                "take": 31,
                "after_time": None,
                "after_id": None,
            },
        )
        Path(output + ".explain.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
        )


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["seed", "bench"])
    parser.add_argument("--account", required=True)
    parser.add_argument("--conversations", type=int, default=1000)
    parser.add_argument("--repeat", type=int, default=100)
    parser.add_argument("--concurrency", nargs="+", type=int, default=[1, 10])
    parser.add_argument("--output", default="/tmp/ichat-search-benchmark.json")
    args = parser.parse_args()
    url = os.environ["DATABASE_URL"]
    if not (make_url(url).database or "").endswith("_search_perf"):
        raise SystemExit("Refusing a database without the _search_perf suffix.")
    engine = create_async_engine(url, hide_parameters=True, pool_size=12)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    if args.command == "seed":
        await seed(factory, args.account, args.conversations)
    else:
        await bench(factory, args.account, args.repeat, args.concurrency, args.output)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
