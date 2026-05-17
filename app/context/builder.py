from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message
from app.models.run import Run
from app.providers import ProviderMessage, ProviderRole


async def build_context(
    session: AsyncSession,
    *,
    run_id: int,
    system_prompt: str,
    budget_chars: int,
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
    trimmed = _trim_to_budget(history, budget_chars=budget_chars)
    return [ProviderMessage(role="system", content=system_prompt), *trimmed]


def _normalize_role(role: str) -> ProviderRole:
    if role == "user":
        return "user"
    if role == "assistant":
        return "assistant"
    raise ValueError(f"Unsupported message role: {role}")


def _trim_to_budget(
    messages: list[ProviderMessage],
    *,
    budget_chars: int,
) -> list[ProviderMessage]:
    total = sum(len(m.content) for m in messages)
    while messages and total > budget_chars and len(messages) > 1:
        dropped = messages.pop(0)
        total -= len(dropped.content)
    return messages
