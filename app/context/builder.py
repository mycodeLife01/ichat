from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message
from app.models.run import Run, RunProviderMessage
from app.providers import ProviderMessage, ProviderRole
from app.services.runs.transcript import provider_message_from_row

# Flat per-message token overhead for role markers and chat-template framing.
_PER_MESSAGE_OVERHEAD_TOKENS = 4


async def build_context(
    session: AsyncSession,
    *,
    run_id: int,
    system_prompt: str,
    budget_tokens: int,
    count_tokens: Callable[[str], int],
) -> list[ProviderMessage]:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    target = await session.get(Message, run.user_message_id)
    if target is None:
        raise LookupError(f"Target user message {run.user_message_id} not found")

    history_rows = (
        await session.scalars(
            select(Message)
            .where(
                Message.conversation_id == run.conversation_id,
                Message.archived_at.is_(None),
                Message.position <= target.position,
            )
            .order_by(Message.position.asc())
        )
    ).all()

    blocks = await _build_history_blocks(
        session,
        history_rows=list(history_rows),
        target_user_message_id=target.id,
    )
    history_budget = budget_tokens - _message_tokens(system_prompt, count_tokens)
    trimmed = _trim_to_budget(
        blocks, budget_tokens=history_budget, count_tokens=count_tokens
    )
    return [ProviderMessage(role="system", content=system_prompt), *_flatten(trimmed)]


async def _build_history_blocks(
    session: AsyncSession,
    *,
    history_rows: list[Message],
    target_user_message_id: int,
) -> list[list[ProviderMessage]]:
    blocks: list[list[ProviderMessage]] = []
    skipped_message_ids: set[int] = set()
    messages_by_run: dict[int, list[Message]] = {}
    for row in history_rows:
        if row.run_id is not None:
            messages_by_run.setdefault(row.run_id, []).append(row)

    for row in history_rows:
        if row.id in skipped_message_ids:
            continue
        if row.role != "user":
            blocks.append([ProviderMessage(role=_normalize_role(row.role), content=row.content)])
            continue

        block = [ProviderMessage(role="user", content=row.content)]
        if row.id != target_user_message_id and row.run_id is not None:
            transcript = await _load_succeeded_run_transcript(session, run_id=row.run_id)
            if transcript:
                block.extend(transcript)
            else:
                for message in messages_by_run.get(row.run_id, []):
                    if message.id == row.id or message.role != "assistant":
                        continue
                    block.append(ProviderMessage(role="assistant", content=message.content))
                    skipped_message_ids.add(message.id)
        blocks.append(block)
    return blocks


async def _load_succeeded_run_transcript(
    session: AsyncSession,
    *,
    run_id: int,
) -> list[ProviderMessage]:
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
    return [provider_message_from_row(row) for row in rows]


def _normalize_role(role: str) -> ProviderRole:
    if role == "user":
        return "user"
    if role == "assistant":
        return "assistant"
    raise ValueError(f"Unsupported message role: {role}")


def _message_tokens(content: str, count_tokens: Callable[[str], int]) -> int:
    return count_tokens(content) + _PER_MESSAGE_OVERHEAD_TOKENS


def _provider_message_tokens(
    message: ProviderMessage,
    count_tokens: Callable[[str], int],
) -> int:
    parts = [message.content or "", message.reasoning_content or ""]
    if message.tool_calls:
        parts.extend(call.arguments for call in message.tool_calls)
    return _message_tokens("\n".join(part for part in parts if part), count_tokens)


def _trim_to_budget(
    blocks: list[list[ProviderMessage]],
    *,
    budget_tokens: int,
    count_tokens: Callable[[str], int],
) -> list[list[ProviderMessage]]:
    costs = [
        sum(_provider_message_tokens(message, count_tokens) for message in block)
        for block in blocks
    ]
    total = sum(costs)
    while blocks and total > budget_tokens and len(blocks) > 1:
        blocks.pop(0)
        total -= costs.pop(0)
    return blocks


def _flatten(blocks: list[list[ProviderMessage]]) -> list[ProviderMessage]:
    return [message for block in blocks for message in block]
