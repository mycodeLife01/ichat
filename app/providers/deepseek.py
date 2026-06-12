import math
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.core.config import Settings
from app.providers.deepseek_parser import parse_sse_line
from app.providers.types import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ProviderToolCall,
    ReasoningDelta,
    TextDelta,
    ThinkingOptions,
    ToolCallDelta,
    ToolCallTurn,
    ToolSpec,
)


class DeepSeekProvider(Provider):
    def __init__(
        self,
        *,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport

    @property
    def name(self) -> str:
        return "deepseek"

    def count_tokens(self, text: str) -> int:
        # Official DeepSeek guidance: ~0.3 tokens per English character,
        # ~0.6 tokens per Chinese character.
        cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
        return math.ceil(cjk * 0.6 + (len(text) - cjk) * 0.3)

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        thinking: ThinkingOptions | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> AsyncIterator[ProviderChunk]:
        # Fall back to env defaults when the run carries no per-request options
        # (legacy rows created before runs.provider_options existed).
        if thinking is None:
            thinking = ThinkingOptions(
                enabled=self._settings.deepseek_thinking_enabled,
                reasoning_effort=self._settings.deepseek_reasoning_effort,
            )
        payload: dict[str, Any] = {
            "model": model,
            "stream": True,
            "messages": [_provider_message_to_payload(m) for m in messages],
            "thinking": {"type": "enabled" if thinking.enabled else "disabled"},
        }
        if tools:
            payload["tools"] = [_tool_spec_to_payload(tool) for tool in tools]
        if thinking.enabled:
            payload["reasoning_effort"] = thinking.reasoning_effort
        headers = {
            "Authorization": f"Bearer {self._settings.deepseek_api_key}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }

        client_kwargs: dict[str, Any] = {
            "base_url": self._settings.deepseek_base_url,
            "timeout": httpx.Timeout(60.0, connect=10.0),
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport

        async with httpx.AsyncClient(**client_kwargs) as client:
            try:
                async with client.stream(
                    "POST",
                    "/chat/completions",
                    json=payload,
                    headers=headers,
                ) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode(errors="replace")
                        raise ProviderError(
                            code="deepseek_http_error",
                            message=f"DeepSeek returned {response.status_code}: {body[:500]}",
                        )
                    provider_request_id = response.headers.get("x-request-id")
                    content_parts: list[str] = []
                    reasoning_parts: list[str] = []
                    tool_builders: dict[int, dict[str, str]] = {}
                    async for line in response.aiter_lines():
                        chunk = parse_sse_line(line)
                        if chunk is None:
                            continue
                        if tools and isinstance(chunk, TextDelta):
                            content_parts.append(chunk.text)
                            continue
                        if tools and isinstance(chunk, ReasoningDelta):
                            reasoning_parts.append(chunk.text)
                            continue
                        if isinstance(chunk, ToolCallDelta):
                            for delta in chunk.calls:
                                builder = tool_builders.setdefault(
                                    delta.index,
                                    {"id": "", "name": "", "arguments": ""},
                                )
                                if delta.id is not None:
                                    builder["id"] += delta.id
                                if delta.name is not None:
                                    builder["name"] += delta.name
                                if delta.arguments is not None:
                                    builder["arguments"] += delta.arguments
                            continue
                        if isinstance(chunk, Finish) and provider_request_id is not None:
                            chunk = Finish(
                                finish_reason=chunk.finish_reason,
                                usage=chunk.usage,
                                provider_request_id=provider_request_id,
                            )
                        if (
                            tools
                            and isinstance(chunk, Finish)
                            and (chunk.finish_reason == "tool_calls" or tool_builders)
                        ):
                            yield ToolCallTurn(
                                content="".join(content_parts) or None,
                                reasoning_content="".join(reasoning_parts) or None,
                                tool_calls=[
                                    ProviderToolCall(
                                        id=builder["id"],
                                        name=builder["name"],
                                        arguments=builder["arguments"],
                                    )
                                    for _, builder in sorted(tool_builders.items())
                                ],
                            )
                            continue
                        if tools and isinstance(chunk, Finish):
                            if reasoning_parts:
                                yield ReasoningDelta(text="".join(reasoning_parts))
                            if content_parts:
                                yield TextDelta(text="".join(content_parts))
                        yield chunk
            except httpx.HTTPError as exc:
                raise ProviderError(
                    code="deepseek_transport_error",
                    message=str(exc),
                ) from exc

    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        payload = {
            "model": model,
            "stream": False,
            "messages": [_provider_message_to_payload(m) for m in messages],
            "thinking": {"type": "disabled"},
            "max_tokens": max_output_tokens,
            "temperature": 0.3,
        }
        headers = {
            "Authorization": f"Bearer {self._settings.deepseek_api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        client_kwargs: dict[str, Any] = {
            "base_url": self._settings.deepseek_base_url,
            "timeout": httpx.Timeout(15.0, connect=5.0),
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport

        async with httpx.AsyncClient(**client_kwargs) as client:
            try:
                response = await client.post(
                    "/chat/completions",
                    json=payload,
                    headers=headers,
                )
                if response.status_code >= 400:
                    raise ProviderError(
                        code="deepseek_summarize_http_error",
                        message=(
                            f"DeepSeek summarize returned {response.status_code}: "
                            f"{response.text[:500]}"
                        ),
                    )
                data = response.json()
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content.strip():
                    raise ProviderError(
                        code="deepseek_summarize_empty",
                        message="DeepSeek summarize returned empty content",
                    )
                return content
            except ProviderError:
                raise
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise ProviderError(
                    code="deepseek_summarize_empty",
                    message="DeepSeek summarize response did not contain message content",
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(
                    code="deepseek_summarize_transport_error",
                    message=str(exc),
                ) from exc


def _tool_spec_to_payload(tool: ToolSpec) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }


def _provider_message_to_payload(message: ProviderMessage) -> dict[str, Any]:
    payload: dict[str, Any] = {"role": message.role}
    if message.content is not None:
        payload["content"] = message.content
    if message.reasoning_content is not None:
        payload["reasoning_content"] = message.reasoning_content
    if message.role == "assistant" and message.tool_calls:
        payload["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": call.arguments,
                },
            }
            for call in message.tool_calls
        ]
    if message.role == "tool" and message.tool_call_id is not None:
        payload["tool_call_id"] = message.tool_call_id
    return payload
