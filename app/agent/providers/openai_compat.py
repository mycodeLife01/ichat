"""Shared machinery for providers speaking the OpenAI Chat Completions protocol.

DeepSeek and OpenAI expose the same wire format through the openai SDK; this
module owns everything protocol-standard — neutral ``Message`` ↔ wire message
translation, streamed tool-call fragment assembly, usage/request-id extraction,
and the shared client singletons. Per-provider quirks (reasoning request fields,
reasoning deltas on the response, error-code prefixes, token ratios) stay in the
subclasses via the small hook surface below.

The SDK clients are process-level singletons (one AsyncOpenAI + one OpenAI per
base_url/api_key), which reuses connections across calls.
"""

import json
from collections.abc import AsyncIterator
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
    AttachmentNoticeBlock,
    DocumentBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from app.agent.provider import (
    Provider,
    ProviderError,
    ReasoningConfig,
    StreamDone,
    StreamEvent,
    TextDelta,
    ToolCallDone,
)
from app.agent.provider import (
    ReasoningDelta as ReasoningDeltaEvent,
)
from app.agent.tools.base import ToolSpec

_STREAM_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
_SYNC_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


@lru_cache(maxsize=8)
def _shared_async_client(*, base_url: str, api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=_STREAM_TIMEOUT, max_retries=2)


@lru_cache(maxsize=8)
def _shared_sync_client(*, base_url: str, api_key: str) -> OpenAI:
    return OpenAI(base_url=base_url, api_key=api_key, timeout=_SYNC_TIMEOUT, max_retries=2)


class OpenAIChatCompletionsProvider(Provider):
    """Base adapter for OpenAI-chat-completions-compatible providers.

    Subclasses declare ``name`` / ``capabilities`` and customize requests via
    the ``_stream_request_extras`` / ``_generate_request_kwargs`` /
    ``_reasoning_from_delta`` hooks; the streaming loop and message translation
    live here once.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        async_client: AsyncOpenAI | None = None,
        sync_client: OpenAI | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url
        self._async_client = async_client
        self._sync_client = sync_client

    # --- subclass hooks -------------------------------------------------

    @property
    def _display_name(self) -> str:
        """Human-readable name used in error messages (e.g. ``DeepSeek``)."""
        raise NotImplementedError

    def _stream_request_extras(
        self, *, model: str, reasoning: ReasoningConfig | None
    ) -> dict[str, Any]:
        """Extra ``chat.completions.create`` kwargs for a streaming call."""
        return {}

    def _generate_request_kwargs(
        self,
        *,
        model: str,
        reasoning: ReasoningConfig | None,
        max_output_tokens: int,
    ) -> dict[str, Any]:
        """Token-limit / sampling / reasoning kwargs for a sync completion."""
        raise NotImplementedError

    def _reasoning_from_delta(self, delta: Any) -> str | None:
        """Extract streamed reasoning text from a chunk delta, if the provider
        emits any (DeepSeek's ``reasoning_content``); ``None`` otherwise."""
        return None

    # Whether replayed assistant turns carry reasoning back as DeepSeek's
    # ``reasoning_content`` field. Strict APIs (OpenAI) reject unknown message
    # fields, so this defaults off.
    _replay_reasoning_in_history: bool = False

    # --- shared implementation -------------------------------------------

    def _async(self) -> AsyncOpenAI:
        if self._async_client is not None:
            return self._async_client
        return _shared_async_client(base_url=self._base_url, api_key=self._api_key)

    def _sync(self) -> OpenAI:
        if self._sync_client is not None:
            return self._sync_client
        return _shared_sync_client(base_url=self._base_url, api_key=self._api_key)

    def _error_code(self, kind: str) -> str:
        return f"{self.name}_{kind}"

    def _should_strip_tool_history(self, tools: list[ToolSpec] | None) -> bool:
        # Some chat templates (DeepSeek) only accept assistant tool_calls / tool
        # results in history when the request itself registers tools; with no
        # tools registered, replayed tool markup leaks as visible text — so
        # strip it. Capability-gated so a provider that can replay tool history
        # unconditionally never strips.
        return not tools and not self.capabilities.supports_tool_history

    async def stream(
        self,
        *,
        model: str,
        messages: list[Message],
        reasoning: ReasoningConfig | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        wire_messages = messages_to_wire(
            messages,
            strip_tool_history=self._should_strip_tool_history(tools),
            replay_reasoning=self._replay_reasoning_in_history,
        )
        create_kwargs: dict[str, Any] = {
            "model": model,
            "messages": wire_messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        create_kwargs.update(self._stream_request_extras(model=model, reasoning=reasoning))
        if tools:
            create_kwargs["tools"] = [tool_spec_to_wire(tool) for tool in tools]

        try:
            response = await self._async().chat.completions.create(**create_kwargs)
        except APIStatusError as exc:
            raise ProviderError(
                code=self._error_code("http_error"),
                message=f"{self._display_name} returned {exc.status_code}: {_error_body(exc)}",
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ProviderError(
                code=self._error_code("transport_error"), message=str(exc)
            ) from exc

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
                reasoning_text = self._reasoning_from_delta(delta)
                if reasoning_text:
                    yield ReasoningDeltaEvent(text=reasoning_text)
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
                            arguments=decode_arguments(buffer["arguments"]),
                        )
                    tool_buffers.clear()
        except APIStatusError as exc:
            raise ProviderError(
                code=self._error_code("http_error"),
                message=f"{self._display_name} returned {exc.status_code}: {_error_body(exc)}",
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ProviderError(
                code=self._error_code("transport_error"), message=str(exc)
            ) from exc

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
        wire_messages = messages_to_wire(
            messages,
            strip_tool_history=not self.capabilities.supports_tool_history,
            replay_reasoning=self._replay_reasoning_in_history,
        )
        create_kwargs: dict[str, Any] = {
            "model": model,
            "messages": cast("Any", wire_messages),
            "stream": False,
        }
        create_kwargs.update(
            self._generate_request_kwargs(
                model=model, reasoning=reasoning, max_output_tokens=max_output_tokens
            )
        )
        try:
            completion: Any = self._sync().chat.completions.create(**create_kwargs)
        except APIStatusError as exc:
            raise ProviderError(
                code=self._error_code("summarize_http_error"),
                message=(
                    f"{self._display_name} summarize returned "
                    f"{exc.status_code}: {_error_body(exc)}"
                ),
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ProviderError(
                code=self._error_code("summarize_transport_error"), message=str(exc)
            ) from exc

        try:
            content = completion.choices[0].message.content
        except (IndexError, AttributeError) as exc:
            raise ProviderError(
                code=self._error_code("summarize_empty"),
                message=f"{self._display_name} summarize response did not contain message content",
            ) from exc
        if not isinstance(content, str) or not content.strip():
            raise ProviderError(
                code=self._error_code("summarize_empty"),
                message=f"{self._display_name} summarize returned empty content",
            )
        return content


def messages_to_wire(
    messages: list[Message], *, strip_tool_history: bool, replay_reasoning: bool = True
) -> list[dict[str, Any]]:
    wire: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "assistant":
            wire.extend(
                _assistant_to_wire(
                    message,
                    strip_tool_history=strip_tool_history,
                    replay_reasoning=replay_reasoning,
                )
            )
        elif message.role == "user":
            wire.extend(_user_to_wire(message, strip_tool_history=strip_tool_history))
        else:  # system
            wire.append({"role": "system", "content": message.text()})
    return wire


def _assistant_to_wire(
    message: Message, *, strip_tool_history: bool, replay_reasoning: bool
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
    if reasoning and replay_reasoning:
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
        elif isinstance(block, DocumentBlock):
            text_parts.append(_document_to_text(block))
        elif isinstance(block, AttachmentNoticeBlock):
            text_parts.append(_attachment_notice_to_text(block))
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


def _document_to_text(block: DocumentBlock) -> str:
    metadata = {
        "file_id": block.file_id,
        "filename": block.filename,
        "media_type": block.media_type,
        "sha256": block.sha256,
        "extractor_version": block.extractor_version,
        "warnings": list(block.warnings),
        "summary": block.summary,
    }
    return (
        "\n\n[BEGIN UNTRUSTED ATTACHMENT]\n"
        f"metadata={json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))}\n"
        f"{block.text}\n"
        "[END UNTRUSTED ATTACHMENT]\n"
    )


def _attachment_notice_to_text(block: AttachmentNoticeBlock) -> str:
    metadata = {
        "file_id": block.file_id,
        "filename": block.filename,
        "media_type": block.media_type,
    }
    return (
        "\n\n[ATTACHMENT NOTICE]\n"
        f"metadata={json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))}\n"
        f"{block.notice}\n"
    )


def tool_spec_to_wire(tool: ToolSpec) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }


def decode_arguments(raw: object) -> dict[str, Any]:
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
