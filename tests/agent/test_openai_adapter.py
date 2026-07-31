"""OpenAI adapter tests driving the openai SDK through an injected mock
transport, mirroring the DeepSeek adapter tests. The interesting deltas from
DeepSeek: tool history replays without tools registered, reasoning_effort is a
typed top-level param gated by model family, and the sync path uses
``max_completion_tokens`` with no pinned temperature.
"""

import json
from typing import Any

import httpx
import pytest
from openai import AsyncOpenAI, OpenAI

from app.agent.messages import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    user_text,
)
from app.agent.provider import (
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    StreamDone,
    TextDelta,
    ToolCallDone,
)
from app.agent.providers.openai import OpenAIProvider, supports_reasoning_control
from app.agent.tools.base import ToolSpec


def sse_body(chunks: list[dict[str, Any]]) -> bytes:
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def chunk(delta: dict[str, Any], *, finish: str | None = None, usage: dict | None = None) -> dict:
    body: dict[str, Any] = {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-test",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        body["usage"] = usage
    return body


def streaming_provider(handler) -> OpenAIProvider:
    client = AsyncOpenAI(
        base_url="http://openai.test/v1",
        api_key="test-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return OpenAIProvider(
        api_key="test-key", base_url="http://openai.test/v1", async_client=client
    )


def sync_provider(handler) -> OpenAIProvider:
    client = OpenAI(
        base_url="http://openai.test/v1",
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return OpenAIProvider(
        api_key="test-key", base_url="http://openai.test/v1", sync_client=client
    )


def stream_response(chunks: list[dict[str, Any]]) -> httpx.Response:
    return httpx.Response(
        200,
        content=sse_body(chunks),
        headers={"content-type": "text/event-stream", "x-request-id": "req-42"},
    )


async def test_stream_text_and_finish_with_usage() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert payload["model"] == "gpt-test"
        return stream_response(
            [
                chunk({"content": "Hello"}),
                chunk({"content": " world"}, finish="stop"),
            ]
        )

    provider = streaming_provider(handler)
    events = [
        event async for event in provider.stream(model="gpt-test", messages=[user_text("hi")])
    ]

    assert events[0] == TextDelta(text="Hello")
    assert events[1] == TextDelta(text=" world")
    done = events[2]
    assert isinstance(done, StreamDone)
    assert done.finish_reason == "stop"
    assert done.provider_request_id == "req-42"


async def test_stream_assembles_tool_call_from_fragments() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return stream_response(
            [
                chunk(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "web_search", "arguments": '{"query":'},
                            }
                        ]
                    }
                ),
                chunk(
                    {"tool_calls": [{"index": 0, "function": {"arguments": '"latest news"}'}}]}
                ),
                chunk({}, finish="tool_calls"),
            ]
        )

    provider = streaming_provider(handler)
    tools = [ToolSpec(name="web_search", description="search", parameters={"type": "object"})]
    events = [
        event
        async for event in provider.stream(
            model="gpt-test", messages=[user_text("hi")], tools=tools
        )
    ]

    call = events[0]
    assert isinstance(call, ToolCallDone)
    assert call.id == "call_1"
    assert call.arguments == {"query": "latest news"}
    assert isinstance(events[1], StreamDone)


def _history_with_tools() -> list[Message]:
    return [
        user_text("latest docs?"),
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("need current docs"),
                ToolCallBlock(id="call_1", name="web_search", arguments={"query": "docs"}),
            ],
        ),
        Message(role="user", blocks=[ToolResultBlock("call_1", "Evidence [1]")]),
        Message(role="assistant", blocks=[TextBlock("Final answer [1]")]),
        user_text("follow up"),
    ]


async def test_stream_keeps_tool_history_without_tools_registered() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(model="gpt-test", messages=_history_with_tools()):
        pass

    roles = [m["role"] for m in captured["messages"]]
    assert "tool" in roles
    assistant_with_calls = [m for m in captured["messages"] if m.get("tool_calls")]
    assert assistant_with_calls and assistant_with_calls[0]["tool_calls"][0]["id"] == "call_1"
    # OpenAI rejects unknown message fields; reasoning never replays.
    assert all("reasoning_content" not in m for m in captured["messages"])


async def test_stream_passes_reasoning_effort_through_for_gpt5() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="gpt-5-mini",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=True, effort="max"),
    ):
        pass

    assert captured["reasoning_effort"] == "max"
    assert "extra_body" not in captured
    assert "thinking" not in captured


async def test_stream_maps_disabled_thinking_to_none_for_gpt5() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="gpt-5-mini",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=False, effort="high"),
    ):
        pass

    assert captured["reasoning_effort"] == "none"


async def test_stream_omits_reasoning_effort_for_non_reasoning_models() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="gpt-4.1-mini",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=True, effort="high"),
    ):
        pass

    assert "reasoning_effort" not in captured


async def test_stream_yields_reasoning_from_openrouter_delta_field() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return stream_response(
            [
                chunk({"reasoning": "think"}),
                chunk({"content": "answer"}),
                chunk({}, finish="stop"),
            ]
        )

    provider = streaming_provider(handler)
    events = [
        event async for event in provider.stream(model="gpt-test", messages=[user_text("hi")])
    ]

    assert events[0] == ReasoningDelta(text="think")
    assert events[1] == TextDelta(text="answer")
    assert isinstance(events[2], StreamDone)


async def test_stream_yields_reasoning_from_reasoning_content_fallback() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return stream_response(
            [
                chunk({"reasoning_content": "think"}),
                chunk({"content": "answer"}, finish="stop"),
            ]
        )

    provider = streaming_provider(handler)
    events = [
        event async for event in provider.stream(model="gpt-test", messages=[user_text("hi")])
    ]

    assert events[0] == ReasoningDelta(text="think")


async def test_stream_raises_provider_error_with_openai_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "server is sad"}})

    provider = streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(model="gpt-test", messages=[user_text("hi")]):
            pass

    assert exc_info.value.code == "openai_http_error"


def completion_response(content: Any) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-2",
            "object": "chat.completion",
            "created": 0,
            "model": "gpt-test",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        },
    )


def test_generate_uses_max_completion_tokens_without_temperature() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return completion_response("Project Plan")

    provider = sync_provider(handler)
    title = provider.generate(
        model="gpt-5-mini", messages=[user_text("summarize")], max_output_tokens=40
    )

    assert title == "Project Plan"
    assert captured["stream"] is False
    assert captured["max_completion_tokens"] == 40
    assert "max_tokens" not in captured
    assert "temperature" not in captured


def test_generate_raises_on_empty_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return completion_response("   ")

    provider = sync_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        provider.generate(model="gpt-test", messages=[user_text("hi")], max_output_tokens=40)

    assert exc_info.value.code == "openai_summarize_empty"


def test_capabilities() -> None:
    provider = OpenAIProvider(api_key="k", base_url="http://openai.test/v1")
    assert provider.capabilities.supports_tool_history is True
    assert provider.capabilities.supports_reasoning is True


def test_count_tokens_uses_openai_ratios() -> None:
    provider = OpenAIProvider(api_key="k", base_url="http://openai.test/v1")
    assert provider.count_tokens("a" * 8) == 2
    assert provider.count_tokens("中" * 10) == 6
    assert provider.count_tokens("") == 0


def test_supports_reasoning_control_by_model_family() -> None:
    assert supports_reasoning_control("gpt-5-mini") is True
    assert supports_reasoning_control("o3-mini") is True
    assert supports_reasoning_control("gpt-4.1-mini") is False


def test_supports_reasoning_control_handles_openrouter_ids() -> None:
    assert supports_reasoning_control("openai/gpt-5.6-luna") is True
    assert supports_reasoning_control("openai/o3-mini") is True
    assert supports_reasoning_control("openai/gpt-5:free") is True
    assert supports_reasoning_control("openai/gpt-4.1-mini") is False
    assert supports_reasoning_control("anthropic/claude-sonnet-5") is False


async def test_stream_sends_reasoning_effort_for_openrouter_gpt5_id() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="openai/gpt-5.6-luna",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=True, effort="high"),
    ):
        pass

    assert captured["model"] == "openai/gpt-5.6-luna"
    assert captured["reasoning_effort"] == "high"
