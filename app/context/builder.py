from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message
from app.models.run import Run
from app.providers import ProviderMessage, ProviderRole

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

    history: list[ProviderMessage] = [
        ProviderMessage(role=_normalize_role(row.role), content=row.content)
        for row in history_rows
    ]
    history_budget = budget_tokens - _message_tokens(system_prompt, count_tokens)
    trimmed = _trim_to_budget(
        history, budget_tokens=history_budget, count_tokens=count_tokens
    )
    return [ProviderMessage(role="system", content=system_prompt), *trimmed]


def _normalize_role(role: str) -> ProviderRole:
    if role == "user":
        return "user"
    if role == "assistant":
        return "assistant"
    raise ValueError(f"Unsupported message role: {role}")


def _message_tokens(content: str, count_tokens: Callable[[str], int]) -> int:
    return count_tokens(content) + _PER_MESSAGE_OVERHEAD_TOKENS


def _trim_to_budget(
    messages: list[ProviderMessage],
    *,
    budget_tokens: int,
    count_tokens: Callable[[str], int],
) -> list[ProviderMessage]:
    costs = [_message_tokens(m.content, count_tokens) for m in messages]
    total = sum(costs)
    while messages and total > budget_tokens and len(messages) > 1:
        messages.pop(0)
        total -= costs.pop(0)
    return messages
