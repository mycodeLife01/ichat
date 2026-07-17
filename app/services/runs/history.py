"""Load conversation history from the store as agent-kernel messages.

This is the business/persistence half of context assembly (the kernel half is
``app/agent/context.py``, which is DB-free): it reads the visible history and
replays succeeded runs' transcripts, yielding a flat ``list[Message]`` in
conversation order. The worker feeds this to ``app.agent.build_context``.
"""

import json
from typing import cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import (
    ContentBlock,
    Message,
    ReasoningBlock,
    Role,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    user_text,
)
from app.models.conversation import Message as MessageRow
from app.models.run import Run, RunProviderMessage


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
    )


async def _build_history(
    session: AsyncSession,
    *,
    history_rows: list[MessageRow],
    target_user_message_id: int,
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

        messages.append(user_text(row.content))
        if row.id != target_user_message_id and row.run_id is not None:
            transcript = await _load_succeeded_run_transcript(session, run_id=row.run_id)
            if transcript:
                messages.extend(transcript)
            else:
                for message in messages_by_run.get(row.run_id, []):
                    if message.id == row.id or message.role != "assistant":
                        continue
                    messages.append(Message(role="assistant", blocks=[TextBlock(message.content)]))
                    skipped_message_ids.add(message.id)
    return messages


async def _load_succeeded_run_transcript(
    session: AsyncSession,
    *,
    run_id: int,
) -> list[Message]:
    run = await session.get(Run, run_id)
    if run is None or run.status != "succeeded":
        return []
    rows = (
        await session.scalars(
            select(RunProviderMessage)
            .where(RunProviderMessage.run_id == run_id)
            .order_by(RunProviderMessage.seq.asc())
        )
    ).all()
    return [_transcript_row_to_message(row) for row in rows]


def _transcript_row_to_message(row: RunProviderMessage) -> Message:
    if row.role == "tool":
        return Message(
            role="user",
            blocks=[
                ToolResultBlock(tool_call_id=row.tool_call_id or "", content=row.content or "")
            ],
        )
    if row.role == "assistant":
        blocks: list[ContentBlock] = []
        if row.reasoning_content:
            blocks.append(ReasoningBlock(text=row.reasoning_content))
        if row.content:
            blocks.append(TextBlock(text=row.content))
        for call in row.tool_calls or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            blocks.append(
                ToolCallBlock(
                    id=str(call.get("id", "")),
                    name=str(function.get("name", "")),
                    arguments=_decode_arguments(function.get("arguments")),
                )
            )
        return Message(role="assistant", blocks=blocks)
    return Message(role="user", blocks=[TextBlock(row.content or "")])


def _decode_arguments(raw: object) -> dict[str, object]:
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _normalize_role(role: str) -> Role:
    if role in ("user", "assistant", "system"):
        return cast(Role, role)
    raise ValueError(f"Unsupported message role: {role}")
