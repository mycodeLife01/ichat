from typing import Any, cast

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.run import RunDraft


async def get_run_draft(session: AsyncSession, *, run_id: int) -> RunDraft | None:
    return cast(
        RunDraft | None,
        await session.scalar(select(RunDraft).where(RunDraft.run_id == run_id)),
    )


async def upsert_run_draft(
    session: AsyncSession,
    *,
    run_id: int,
    seq: int,
    text: str,
    reasoning: str,
    reasoning_summary: str = "",
    events: list[dict[str, Any]] | None = None,
) -> None:
    statement = insert(RunDraft).values(
        run_id=run_id,
        seq=seq,
        text=text,
        reasoning=reasoning,
        reasoning_summary=reasoning_summary,
        events=events or [],
    )
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[RunDraft.run_id],
            set_={
                "seq": statement.excluded.seq,
                "text": statement.excluded.text,
                "reasoning": statement.excluded.reasoning,
                "reasoning_summary": statement.excluded.reasoning_summary,
                "events": statement.excluded.events,
                "updated_at": func.now(),
            },
        )
    )


async def delete_run_draft(session: AsyncSession, *, run_id: int) -> None:
    await session.execute(delete(RunDraft).where(RunDraft.run_id == run_id))
