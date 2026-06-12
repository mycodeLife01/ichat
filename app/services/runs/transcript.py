import json
from collections.abc import Callable
from typing import Any, Literal, cast

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.run import RunProviderMessage
from app.providers import ProviderMessage, ProviderRole, ProviderToolCall

ProviderTranscriptRole = Literal["user", "assistant", "tool"]


async def append_provider_message(
    session: AsyncSession,
    *,
    run_id: int,
    role: ProviderTranscriptRole,
    content: str | None = None,
    reasoning_content: str | None = None,
    tool_call_id: str | None = None,
    tool_name: str | None = None,
    tool_calls: list[ProviderToolCall] | None = None,
    payload: dict[str, Any] | None = None,
    message_id: int | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> RunProviderMessage:
    next_seq = await get_next_provider_message_seq(session, run_id=run_id)
    stored_tool_calls = serialize_tool_calls(tool_calls) if tool_calls is not None else None
    row = RunProviderMessage(
        run_id=run_id,
        seq=next_seq,
        message_id=message_id,
        role=role,
        content=content,
        reasoning_content=reasoning_content,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        tool_calls=stored_tool_calls,
        payload=payload,
        estimated_tokens=_estimate_tokens(
            content=content,
            reasoning_content=reasoning_content,
            tool_calls=stored_tool_calls,
            payload=payload,
            count_tokens=count_tokens,
        ),
    )
    session.add(row)
    await session.flush()
    return row


async def backfill_provider_message_id(
    session: AsyncSession,
    *,
    provider_message_id: int,
    message_id: int,
) -> None:
    await session.execute(
        update(RunProviderMessage)
        .where(RunProviderMessage.id == provider_message_id)
        .values(message_id=message_id)
    )


async def get_next_provider_message_seq(session: AsyncSession, *, run_id: int) -> int:
    max_seq = await session.scalar(
        select(func.max(RunProviderMessage.seq)).where(RunProviderMessage.run_id == run_id)
    )
    if max_seq is None:
        return 1
    return max_seq + 1


def serialize_tool_calls(tool_calls: list[ProviderToolCall]) -> list[dict[str, Any]]:
    return [
        {
            "id": call.id,
            "type": "function",
            "function": {"name": call.name, "arguments": call.arguments},
        }
        for call in tool_calls
    ]


def provider_message_from_row(row: RunProviderMessage) -> ProviderMessage:
    tool_calls = None
    if row.tool_calls:
        tool_calls = [
            ProviderToolCall(
                id=str(item.get("id", "")),
                name=str((item.get("function") or {}).get("name", "")),
                arguments=str((item.get("function") or {}).get("arguments", "")),
            )
            for item in row.tool_calls
            if isinstance(item, dict)
        ]
    return ProviderMessage(
        role=cast(ProviderRole, row.role),
        content=row.content,
        reasoning_content=row.reasoning_content,
        tool_calls=tool_calls,
        tool_call_id=row.tool_call_id,
        tool_name=row.tool_name,
    )


def _estimate_tokens(
    *,
    content: str | None,
    reasoning_content: str | None,
    tool_calls: list[dict[str, Any]] | None,
    payload: dict[str, Any] | None,
    count_tokens: Callable[[str], int] | None,
) -> int:
    if count_tokens is None:
        return 0
    parts = [content or "", reasoning_content or ""]
    if tool_calls:
        parts.append(json.dumps(tool_calls, ensure_ascii=False, separators=(",", ":")))
    if payload:
        parts.append(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return count_tokens("\n".join(part for part in parts if part))
