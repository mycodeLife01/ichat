"""Single-call primitives for the agent kernel — the building blocks the
orchestration layer composes into a loop.

``stream_model_call`` runs exactly one model call: deltas flow up in real time,
tool calls are buffered and delivered assembled inside the terminal
``ModelCallResult``. ``execute_tool`` runs one tool mechanically. Neither knows
about runs, seq numbers, sinks, retries, or cancellation — they are only
cancel-*safe* (a ``CancelledError`` thrown at an await point cleans up and
propagates, never swallowed).
"""

import contextlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from app.agent.messages import (
    ContentBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
)
from app.agent.provider import (
    Provider,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    StreamDone,
    TextDelta,
    ToolCallDone,
)
from app.agent.tools.base import Tool, ToolResult, ToolSpec


@dataclass(frozen=True)
class ModelCallResult:
    """Terminal item of ``stream_model_call``: the assembled assistant message
    plus the model call's usage and request id."""

    message: Message
    usage: dict[str, Any] | None
    provider_request_id: str | None


async def stream_model_call(
    provider: Provider,
    *,
    model: str,
    messages: list[Message],
    reasoning: ReasoningConfig | None,
    tools: list[ToolSpec] | None,
) -> AsyncIterator[TextDelta | ReasoningDelta | ModelCallResult]:
    """Stream one model call.

    Yields ``TextDelta`` / ``ReasoningDelta`` as they arrive, buffers
    ``ToolCallDone`` fragments, and on the provider's terminal ``StreamDone``
    yields a single ``ModelCallResult`` with the assembled assistant message.
    Raises ``ProviderError`` on provider failure or if the stream ends without a
    finish event.
    """
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[ToolCallBlock] = []

    stream = provider.stream(model=model, messages=messages, reasoning=reasoning, tools=tools)
    try:
        async for event in stream:
            if isinstance(event, ReasoningDelta):
                reasoning_parts.append(event.text)
                yield event
            elif isinstance(event, TextDelta):
                text_parts.append(event.text)
                yield event
            elif isinstance(event, ToolCallDone):
                tool_calls.append(
                    ToolCallBlock(id=event.id, name=event.name, arguments=event.arguments)
                )
            elif isinstance(event, StreamDone):
                blocks: list[ContentBlock] = []
                reasoning_text = "".join(reasoning_parts)
                content = "".join(text_parts)
                if reasoning_text:
                    blocks.append(ReasoningBlock(text=reasoning_text))
                if content:
                    blocks.append(TextBlock(text=content))
                blocks.extend(tool_calls)
                yield ModelCallResult(
                    message=Message(role="assistant", blocks=blocks),
                    usage=event.usage,
                    provider_request_id=event.provider_request_id,
                )
                return
    finally:
        aclose = getattr(stream, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()

    raise ProviderError(
        code="no_finish",
        message="Provider stream ended without a finish event",
    )


async def execute_tool(tool: Tool, arguments: dict[str, Any]) -> ToolResult:
    """Run one tool mechanically. Any exception becomes an error ``ToolResult``;
    ``CancelledError`` propagates (it is not an ``Exception``). Limit and
    unknown-tool semantics are the orchestration layer's, not this primitive's."""
    try:
        return await tool.execute(arguments)
    except Exception as exc:  # noqa: BLE001 - mechanical: any tool failure is an error result
        message = str(exc) or exc.__class__.__name__
        return ToolResult(
            content=f"{message} (tool_execution_error)",
            is_error=True,
            metadata={"error_code": "tool_execution_error", "message": message},
        )


__all__ = [
    "ModelCallResult",
    "execute_tool",
    "stream_model_call",
]
