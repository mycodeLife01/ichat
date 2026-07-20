"""DeepSeek provider adapter built on the openai SDK.

This is the single place DeepSeek's wire format and quirks live. Neutral
``Message`` blocks are translated to OpenAI chat-completion messages here, and the
provider's inability to replay tool history without tools registered is declared
as a ``ProviderCapabilities`` flag rather than a passthrough flag on the context
builder. Non-standard DeepSeek fields (``thinking`` / ``reasoning_effort`` on the
request, ``reasoning_content`` on the response) go through ``extra_body`` and
untyped attribute access, kept together and commented.

The SDK clients are process-level singletons (one AsyncOpenAI + one OpenAI per
base_url/api_key), which reuses connections and fixes the previous adapter's
per-call ``httpx.AsyncClient`` construction.
"""

import json
import math
from collections.abc import AsyncIterator, Mapping
from functools import lru_cache
from typing import Any, cast

import httpx
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    OpenAI,
)

from app.agent.messages import (
    ContentBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from app.agent.provider import (
    Provider,
    ProviderCapabilities,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    StreamDone,
    StreamEvent,
    TextDelta,
    ToolCallDone,
)
from app.agent.tools.base import ToolSpec

_CAPABILITIES = ProviderCapabilities(supports_tool_history=False, supports_reasoning=True)

_STREAM_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
_SYNC_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


@lru_cache(maxsize=8)
def _shared_async_client(*, base_url: str, api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=_STREAM_TIMEOUT, max_retries=2)


@lru_cache(maxsize=8)
def _shared_sync_client(*, base_url: str, api_key: str) -> OpenAI:
    return OpenAI(base_url=base_url, api_key=api_key, timeout=_SYNC_TIMEOUT, max_retries=2)


class DeepSeekProvider(Provider):
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        default_thinking_enabled: bool,
        default_reasoning_effort: str,
        async_client: AsyncOpenAI | None = None,
        sync_client: OpenAI | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url
        self._default_thinking_enabled = default_thinking_enabled
        self._default_reasoning_effort = default_reasoning_effort
        self._async_client = async_client
        self._sync_client = sync_client

    @property
    def name(self) -> str:
        return "deepseek"

    @property
    def capabilities(self) -> ProviderCapabilities:
        return _CAPABILITIES

    def count_tokens(self, text: str) -> int:
        # Official DeepSeek guidance: ~0.3 tokens per English character,
        # ~0.6 tokens per Chinese character.
        cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
        return math.ceil(cjk * 0.6 + (len(text) - cjk) * 0.3)

    def _async(self) -> AsyncOpenAI:
        if self._async_client is not None:
            return self._async_client
        return _shared_async_client(base_url=self._base_url, api_key=self._api_key)

    def _sync(self) -> OpenAI:
        if self._sync_client is not None:
            return self._sync_client
        return _shared_sync_client(base_url=self._base_url, api_key=self._api_key)

    async def stream(
        self,
        *,
        model: str,
        messages: list[Message],
        reasoning: ReasoningConfig | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        if reasoning is None:
            reasoning = ReasoningConfig(
                enabled=self._default_thinking_enabled,
                effort=self._default_reasoning_effort,
            )
        wire_messages = _messages_to_wire(
            messages, strip_tool_history=_should_strip_tool_history(tools)
        )
        # DeepSeek-specific request fields have no place in the typed openai
        # params, so they ride in extra_body: `thinking` gates reasoning, and
        # `reasoning_effort` tunes it (only meaningful when enabled).
        extra_body: dict[str, Any] = {
            "thinking": {"type": "enabled" if reasoning.enabled else "disabled"}
        }
        if reasoning.enabled:
            extra_body["reasoning_effort"] = reasoning.effort

        create_kwargs: dict[str, Any] = {
            "model": model,
            "messages": wire_messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            "extra_body": extra_body,
        }
        if tools:
            create_kwargs["tools"] = [_tool_spec_to_wire(tool) for tool in tools]

        try:
            response = await self._async().chat.completions.create(**create_kwargs)
        except APIStatusError as exc:
            raise ProviderError(
                code="deepseek_http_error",
                message=f"DeepSeek returned {exc.status_code}: {_error_body(exc)}",
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ProviderError(code="deepseek_transport_error", message=str(exc)) from exc

        request_id = _request_id(response)
        tool_buffers: dict[int, dict[str, str]] = {}
        finish_reason: str | None = None
        usage: dict[str, Any] | None = None
        try:
            async for chunk in response:
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    usage = _usage_to_dict(chunk_usage)
                choices = chunk.choices
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.delta
                # `reasoning_content` is a DeepSeek extension absent from the
                # typed delta model; reach it via untyped attribute access.
                reasoning_text = getattr(delta, "reasoning_content", None)
                if isinstance(reasoning_text, str) and reasoning_text:
                    yield ReasoningDelta(text=reasoning_text)
                if delta.content:
                    yield TextDelta(text=delta.content)
                for tool_delta in delta.tool_calls or []:
                    buffer = tool_buffers.setdefault(
                        tool_delta.index, {"id": "", "name": "", "arguments": ""}
                    )
                    if tool_delta.id:
                        buffer["id"] += tool_delta.id
                    function = tool_delta.function
                    if function is not None:
                        if function.name:
                            buffer["name"] += function.name
                        if function.arguments:
                            buffer["arguments"] += function.arguments
                if choice.finish_reason is not None:
                    finish_reason = choice.finish_reason
                    for _, buffer in sorted(tool_buffers.items()):
                        yield ToolCallDone(
                            id=buffer["id"],
                            name=buffer["name"],
                            arguments=_decode_arguments(buffer["arguments"]),
                        )
                    tool_buffers.clear()
        except APIStatusError as exc:
            raise ProviderError(
                code="deepseek_http_error",
                message=f"DeepSeek returned {exc.status_code}: {_error_body(exc)}",
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ProviderError(code="deepseek_transport_error", message=str(exc)) from exc

        yield StreamDone(
            finish_reason=finish_reason or "stop",
            usage=usage,
            provider_request_id=request_id,
        )

    def generate(
        self,
        *,
        model: str,
        messages: list[Message],
        max_output_tokens: int,
        reasoning: ReasoningConfig | None = None,
    ) -> str:
        wire_messages = _messages_to_wire(messages, strip_tool_history=True)
        enabled = reasoning.enabled if reasoning is not None else False
        extra_body: dict[str, Any] = {
            "thinking": {"type": "enabled" if enabled else "disabled"}
        }
        if enabled and reasoning is not None:
            extra_body["reasoning_effort"] = reasoning.effort
        try:
            completion: Any = self._sync().chat.completions.create(
                model=model,
                messages=cast("Any", wire_messages),
                stream=False,
                max_tokens=max_output_tokens,
                temperature=0.3,
                extra_body=extra_body,
            )
        except APIStatusError as exc:
            raise ProviderError(
                code="deepseek_summarize_http_error",
                message=f"DeepSeek summarize returned {exc.status_code}: {_error_body(exc)}",
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ProviderError(
                code="deepseek_summarize_transport_error", message=str(exc)
            ) from exc

        try:
            content = completion.choices[0].message.content
        except (IndexError, AttributeError) as exc:
            raise ProviderError(
                code="deepseek_summarize_empty",
                message="DeepSeek summarize response did not contain message content",
            ) from exc
        if not isinstance(content, str) or not content.strip():
            raise ProviderError(
                code="deepseek_summarize_empty",
                message="DeepSeek summarize returned empty content",
            )
        return content


def _should_strip_tool_history(tools: list[ToolSpec] | None) -> bool:
    # DeepSeek's chat template only accepts assistant tool_calls / tool results in
    # history when the request itself registers tools. With no tools registered,
    # replayed tool markup leaks as visible text — so strip it. Capability-gated
    # so a provider that can replay tool history unconditionally never strips.
    return not tools and not _CAPABILITIES.supports_tool_history


def message_from_wire(wire: Mapping[str, Any]) -> Message:
    """Convert one legacy DeepSeek/OpenAI wire message to neutral blocks.

    This is intentionally owned by the adapter: persisted rows created before the
    blocks migration contain DeepSeek's wire fields, and the transcript service
    must not learn how to interpret them.
    """
    role = wire.get("role")
    content = wire.get("content")
    if role == "tool":
        return Message(
            role="user",
            blocks=[
                ToolResultBlock(
                    tool_call_id=str(wire.get("tool_call_id") or ""),
                    content=content if isinstance(content, str) else "",
                )
            ],
        )
    if role == "assistant":
        blocks: list[ContentBlock] = []
        reasoning = wire.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning:
            blocks.append(ReasoningBlock(text=reasoning))
        if isinstance(content, str) and content:
            blocks.append(TextBlock(text=content))
        tool_calls = wire.get("tool_calls")
        if isinstance(tool_calls, list):
            for item in tool_calls:
                if not isinstance(item, Mapping):
                    continue
                function = item.get("function")
                if not isinstance(function, Mapping):
                    continue
                blocks.append(
                    ToolCallBlock(
                        id=str(item.get("id") or ""),
                        name=str(function.get("name") or ""),
                        arguments=_decode_arguments(function.get("arguments")),
                    )
                )
        return Message(role="assistant", blocks=blocks)
    if role == "user":
        return Message(
            role="user",
            blocks=[TextBlock(text=content if isinstance(content, str) else "")],
        )
    if role == "system":
        return Message(
            role="system",
            blocks=[TextBlock(text=content if isinstance(content, str) else "")],
        )
    raise ValueError(f"Unsupported DeepSeek message role: {role!r}")


def _messages_to_wire(
    messages: list[Message], *, strip_tool_history: bool
) -> list[dict[str, Any]]:
    wire: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "assistant":
            wire.extend(_assistant_to_wire(message, strip_tool_history=strip_tool_history))
        elif message.role == "user":
            wire.extend(_user_to_wire(message, strip_tool_history=strip_tool_history))
        else:  # system
            wire.append({"role": "system", "content": message.text()})
    return wire


def _assistant_to_wire(
    message: Message, *, strip_tool_history: bool
) -> list[dict[str, Any]]:
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for block in message.blocks:
        if isinstance(block, TextBlock):
            content_parts.append(block.text)
        elif isinstance(block, ReasoningBlock):
            reasoning_parts.append(block.text)
        elif isinstance(block, ToolCallBlock) and not strip_tool_history:
            tool_calls.append(
                {
                    "id": block.id,
                    "type": "function",
                    "function": {
                        "name": block.name,
                        "arguments": json.dumps(block.arguments, ensure_ascii=False),
                    },
                }
            )
    content = "".join(content_parts)
    # A stripped pure tool-call turn (no answer text) has nothing to replay.
    if strip_tool_history and not content:
        return []
    payload: dict[str, Any] = {"role": "assistant", "content": content or None}
    reasoning = "".join(reasoning_parts)
    if reasoning:
        payload["reasoning_content"] = reasoning
    if tool_calls:
        payload["tool_calls"] = tool_calls
    return [payload]


def _user_to_wire(message: Message, *, strip_tool_history: bool) -> list[dict[str, Any]]:
    # OpenAI carries tool results as separate tool-role messages, not inside the
    # user turn, so a neutral user message with ToolResultBlocks fans out.
    wire: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for block in message.blocks:
        if isinstance(block, TextBlock):
            text_parts.append(block.text)
        elif isinstance(block, ToolResultBlock) and not strip_tool_history:
            wire.append(
                {
                    "role": "tool",
                    "tool_call_id": block.tool_call_id,
                    "content": block.content,
                }
            )
    text = "".join(text_parts)
    if text or not wire:
        wire.append({"role": "user", "content": text})
    return wire


def _tool_spec_to_wire(tool: ToolSpec) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }


def _decode_arguments(raw: object) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _usage_to_dict(usage: Any) -> dict[str, Any] | None:
    dump = getattr(usage, "model_dump", None)
    if callable(dump):
        result = dump(exclude_none=True)
        return result if isinstance(result, dict) else None
    return usage if isinstance(usage, dict) else None


def _request_id(response: Any) -> str | None:
    raw = getattr(response, "response", None)
    if raw is not None:
        headers = getattr(raw, "headers", None)
        if headers is not None:
            value = headers.get("x-request-id")
            if isinstance(value, str):
                return value
    return None


def _error_body(exc: APIStatusError) -> str:
    body = getattr(exc, "message", None) or str(exc)
    return body[:500]
