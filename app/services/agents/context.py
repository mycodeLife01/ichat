"""Context assembly for the orchestration layer — the agent's working "memory".

Given a system prompt and the conversation history as a flat ``list[Message]``,
organize it into a single budgeted message list for the agent loop. Pure:
operates only on kernel message types, injects a token counter, and never touches
a database, ORM, or provider. Loading history *from* a store is a business
concern and lives in ``app/services/runs`` — not here.

Trimming keeps the newest messages within budget and never leaves a dangling
tool exchange: it only cuts at a *turn boundary* (a genuine user message), so an
assistant tool call is never separated from its tool result. Turn boundaries are
derived from the flat list internally — callers pass and receive plain
``list[Message]`` (the shape every provider message API uses).
"""

import json
from collections.abc import Callable

from app.agent.messages import (
    AttachmentNoticeBlock,
    ContentBlock,
    DocumentBlock,
    Message,
    ToolCallBlock,
    ToolResultBlock,
    system_text,
)

# Flat per-message token overhead for role markers and chat-template framing.
_PER_MESSAGE_OVERHEAD_TOKENS = 4


def build_context(
    *,
    system_prompt: str,
    history: list[Message],
    budget_tokens: int,
    count_tokens: Callable[[str], int],
) -> list[Message]:
    """Prepend the system prompt and trim the oldest turns to fit the budget."""
    history_budget = budget_tokens - _message_tokens(system_text(system_prompt), count_tokens)
    kept = _trim_to_budget(history, budget_tokens=history_budget, count_tokens=count_tokens)
    return [system_text(system_prompt), *kept]


def estimate_message_tokens(
    message: Message,
    *,
    count_tokens: Callable[[str], int],
) -> int:
    """Public admission-control counterpart to context trimming."""

    return _message_tokens(message, count_tokens)


def _is_turn_boundary(message: Message) -> bool:
    """A genuine user turn — a user message carrying something other than tool
    results (which are continuations of the preceding assistant turn)."""
    return message.role == "user" and any(
        not isinstance(block, ToolResultBlock) for block in message.blocks
    )


def _trim_to_budget(
    history: list[Message],
    *,
    budget_tokens: int,
    count_tokens: Callable[[str], int],
) -> list[Message]:
    if not history:
        return []
    # Segment at turn boundaries so trimming drops whole turns; a leading
    # fragment before the first boundary stays attached to the first segment.
    starts = [i for i, message in enumerate(history) if _is_turn_boundary(message)]
    if not starts or starts[0] != 0:
        starts = [0, *starts]
    bounds = [*starts, len(history)]
    segments = [history[a:b] for a, b in zip(bounds, bounds[1:], strict=False)]
    costs = [
        sum(_message_tokens(message, count_tokens) for message in segment)
        for segment in segments
    ]
    total = sum(costs)
    while len(segments) > 1 and total > budget_tokens:
        segments.pop(0)
        total -= costs.pop(0)
    return [message for segment in segments for message in segment]


def _block_text(block: ContentBlock) -> str:
    if isinstance(block, ToolCallBlock):
        return json.dumps(block.arguments, ensure_ascii=False)
    if isinstance(block, ToolResultBlock):
        return block.content
    if isinstance(block, AttachmentNoticeBlock):
        return "\n".join((block.filename, block.media_type, block.notice))
    if isinstance(block, DocumentBlock):
        metadata = "\n".join(
            (
                block.filename,
                block.media_type,
                block.sha256,
                block.extractor_version,
                *block.warnings,
            )
        )
        return f"{metadata}\n{block.text}"
    return block.text


def _message_tokens(message: Message, count_tokens: Callable[[str], int]) -> int:
    text = "\n".join(part for part in (_block_text(b) for b in message.blocks) if part)
    return count_tokens(text) + _PER_MESSAGE_OVERHEAD_TOKENS
