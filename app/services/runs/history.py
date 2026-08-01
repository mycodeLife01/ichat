"""Load conversation history from the store as agent-kernel messages.

This is the business/persistence half of context assembly (the kernel half is
``app/agent/context.py``, which is DB-free): it reads the visible history and
replays succeeded runs' transcripts, yielding a flat ``list[Message]`` in
conversation order. The worker feeds this to ``app.agent.build_context``.
"""

from typing import cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import Message, Role, TextBlock, user_text
from app.models.conversation import Message as MessageRow
from app.models.run import Run
from app.services.runs.transcript import load_transcript


async def load_conversation_history(
    session: AsyncSession,
    *,
    run_id: int,
) -> list[Message]:
    """Return the visible history up to the run's target user message as neutral
    ``Message``s in order (user turns interleaved with replayed transcripts)."""
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    target = await session.get(MessageRow, run.user_message_id)
    if target is None:
        raise LookupError(f"Target user message {run.user_message_id} not found")

    history_rows = (
        await session.scalars(
            select(MessageRow)
            .where(
                MessageRow.conversation_id == run.conversation_id,
                MessageRow.archived_at.is_(None),
                MessageRow.position <= target.position,
            )
            .order_by(MessageRow.position.asc())
        )
    ).all()

    return await _build_history(
        session,
        history_rows=list(history_rows),
        target_user_message_id=target.id,
        target_run_id=run.id,
    )


async def _build_history(
    session: AsyncSession,
    *,
    history_rows: list[MessageRow],
    target_user_message_id: int,
    target_run_id: int | None = None,
) -> list[Message]:
    messages: list[Message] = []
    skipped_message_ids: set[int] = set()
    messages_by_run: dict[int, list[MessageRow]] = {}
    for row in history_rows:
        if row.run_id is not None:
            messages_by_run.setdefault(row.run_id, []).append(row)

    for row in history_rows:
        if row.id in skipped_message_ids:
            continue
        if row.role != "user":
            messages.append(
                Message(role=_normalize_role(row.role), blocks=[TextBlock(row.content)])
            )
            continue

        replay_run_id = target_run_id if row.id == target_user_message_id else row.run_id
        transcript = (
            await _load_run_transcript_for_history(
                session,
                run_id=replay_run_id,
                require_succeeded=row.id != target_user_message_id,
            )
            if replay_run_id is not None
            else []
        )
        # New transcripts are self-contained and start with the exact user
        # input blocks (including attachment extracts). Legacy transcripts
        # start at the assistant output, so retain the message-row fallback.
        if transcript and transcript[0].role == "user":
            messages.extend(transcript)
        else:
            messages.append(user_text(row.content))
            if row.id != target_user_message_id and transcript:
                messages.extend(transcript)
        if row.id != target_user_message_id and row.run_id is not None:
            if transcript:
                # A completed transcript already contains the provider output.
                # Skip its materialized assistant rows so new self-contained
                # transcripts do not replay the same answer twice.
                skipped_message_ids.update(
                    message.id
                    for message in messages_by_run.get(row.run_id, [])
                    if message.id != row.id and message.role == "assistant"
                )
    return messages


async def _load_run_transcript_for_history(
    session: AsyncSession,
    *,
    run_id: int | None,
    require_succeeded: bool,
) -> list[Message]:
    if run_id is None:
        return []
    run = await session.get(Run, run_id)
    if run is None:
        return []
    transcript = await load_transcript(session, run_id=run_id)
    if require_succeeded and run.status != "succeeded":
        # New runs persist their exact user input before execution.  Preserve
        # that attachment snapshot after a failed/cancelled attempt, while
        # never replaying partial provider output.  Legacy transcripts start
        # with assistant/tool output and therefore still fall back to the
        # message row alone.
        return transcript[:1] if transcript and transcript[0].role == "user" else []
    return transcript


def _normalize_role(role: str) -> Role:
    if role in ("user", "assistant", "system"):
        return cast(Role, role)
    raise ValueError(f"Unsupported message role: {role}")
