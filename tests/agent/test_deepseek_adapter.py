"""DeepSeek adapter tests driving the openai SDK through an injected mock
transport (the SDK accepts a custom ``http_client``), so no network is touched.
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
from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.tools.base import ToolSpec
from app.core.config import Settings, get_settings


def make_settings() -> Settings:
    return get_settings()


def sse_body(chunks: list[dict[str, Any]]) -> bytes:
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def chunk(delta: dict[str, Any], *, finish: str | None = None, usage: dict | None = None) -> dict:
    body: dict[str, Any] = {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "deepseek-test",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        body["usage"] = usage
    return body


def usage_only_chunk(usage: dict) -> dict:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "deepseek-test",
        "choices": [],
        "usage": usage,
    }


def streaming_provider(handler, *, settings: Settings | None = None) -> DeepSeekProvider:
    client = AsyncOpenAI(
        base_url="http://deepseek.test/v1",
        api_key="test-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return DeepSeekProvider(settings=settings or make_settings(), async_client=client)


def sync_provider(handler, *, settings: Settings | None = None) -> DeepSeekProvider:
    client = OpenAI(
        base_url="http://deepseek.test/v1",
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return DeepSeekProvider(settings=settings or make_settings(), sync_client=client)


def stream_response(
    chunks: list[dict[str, Any]], *, request_id: str | None = "req-77"
) -> httpx.Response:
    headers = {"content-type": "text/event-stream"}
    if request_id is not None:
        headers["x-request-id"] = request_id
    return httpx.Response(200, content=sse_body(chunks), headers=headers)


async def test_stream_text_and_finish_with_usage() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert payload["model"] == "deepseek-test"
        return stream_response(
            [
                chunk({"content": "Hello"}),
                chunk({"content": " world"}),
                chunk({}, finish="stop"),
                usage_only_chunk({"prompt_tokens": 4, "completion_tokens": 2}),
            ]
        )

    provider = streaming_provider(handler)
    events = [
        event
        async for event in provider.stream(model="deepseek-test", messages=[user_text("hi")])
    ]

    assert events[0] == TextDelta(text="Hello")
    assert events[1] == TextDelta(text=" world")
    done = events[2]
    assert isinstance(done, StreamDone)
    assert done.finish_reason == "stop"
    assert done.usage == {"prompt_tokens": 4, "completion_tokens": 2}
    assert done.provider_request_id == "req-77"


async def test_stream_reasoning_then_text() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return stream_response(
            [
                chunk({"reasoning_content": "think"}),
                chunk({"content": "answer"}),
                chunk({}, finish="stop"),
            ]
        )

    provider = streaming_provider(handler)
    events = [
        event
        async for event in provider.stream(model="deepseek-test", messages=[user_text("hi")])
    ]

    assert events[0] == ReasoningDelta(text="think")
    assert events[1] == TextDelta(text="answer")
    assert isinstance(events[2], StreamDone)


async def test_stream_assembles_tool_call_from_fragments() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["tools"][0]["function"]["name"] == "web_search"
        return stream_response(
            [
                chunk({"reasoning_content": "need search"}),
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
            model="deepseek-test", messages=[user_text("hi")], tools=tools
        )
    ]

    assert events[0] == ReasoningDelta(text="need search")
    call = events[1]
    assert isinstance(call, ToolCallDone)
    assert call.id == "call_1"
    assert call.name == "web_search"
    assert call.arguments == {"query": "latest news"}
    done = events[2]
    assert isinstance(done, StreamDone)
    assert done.finish_reason == "tool_calls"


async def test_stream_raises_provider_error_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "server is sad"}})

    provider = streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(model="deepseek-test", messages=[user_text("hi")]):
            pass

    assert exc_info.value.code == "deepseek_http_error"


async def test_stream_sends_thinking_enabled_and_effort() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    settings = make_settings().model_copy(
        update={"deepseek_thinking_enabled": True, "deepseek_reasoning_effort": "high"}
    )
    provider = streaming_provider(handler, settings=settings)
    async for _ in provider.stream(model="deepseek-test", messages=[user_text("hi")]):
        pass

    assert captured["thinking"] == {"type": "enabled"}
    assert captured["reasoning_effort"] == "high"


async def test_stream_disables_thinking_and_omits_effort() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": False})
    provider = streaming_provider(handler, settings=settings)
    async for _ in provider.stream(model="deepseek-test", messages=[user_text("hi")]):
        pass

    assert captured["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in captured


async def test_stream_per_request_reasoning_overrides_settings() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": False})
    provider = streaming_provider(handler, settings=settings)
    async for _ in provider.stream(
        model="deepseek-test",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=True, effort="max"),
    ):
        pass

    assert captured["thinking"] == {"type": "enabled"}
    assert captured["reasoning_effort"] == "max"


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


async def test_stream_keeps_tool_history_when_tools_registered() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    tools = [ToolSpec(name="web_search", description="search", parameters={"type": "object"})]
    async for _ in provider.stream(
        model="deepseek-test", messages=_history_with_tools(), tools=tools
    ):
        pass

    roles = [m["role"] for m in captured["messages"]]
    assert "tool" in roles
    assistant_with_calls = [m for m in captured["messages"] if m.get("tool_calls")]
    assert assistant_with_calls and assistant_with_calls[0]["tool_calls"][0]["id"] == "call_1"


async def test_stream_strips_tool_history_when_no_tools_registered() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(model="deepseek-test", messages=_history_with_tools()):
        pass

    messages = captured["messages"]
    assert all(m["role"] != "tool" for m in messages)
    assert all(not m.get("tool_calls") for m in messages)
    # The final assistant answer survives; the pure tool-call turn is dropped.
    assistant = [m for m in messages if m["role"] == "assistant"]
    assert len(assistant) == 1
    assert assistant[0]["content"] == "Final answer [1]"


def test_count_tokens_uses_deepseek_ratios() -> None:
    provider = DeepSeekProvider(settings=make_settings())
    assert provider.count_tokens("a" * 10) == 3
    assert provider.count_tokens("中" * 10) == 6
    assert provider.count_tokens("abcd中文") == 3
    assert provider.count_tokens("") == 0


def test_capabilities() -> None:
    provider = DeepSeekProvider(settings=make_settings())
    assert provider.capabilities.supports_tool_history is False
    assert provider.capabilities.supports_reasoning is True


def completion_response(content: Any) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-2",
            "object": "chat.completion",
            "created": 0,
            "model": "deepseek-summary",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        },
    )


def test_generate_returns_message_content() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return completion_response("Project Plan")

    provider = sync_provider(handler)
    title = provider.generate(
        model="deepseek-summary", messages=[user_text("summarize")], max_output_tokens=40
    )

    assert title == "Project Plan"
    assert captured["stream"] is False
    assert captured["max_tokens"] == 40
    assert captured["temperature"] == 0.3
    assert captured["thinking"] == {"type": "disabled"}


def test_generate_raises_on_empty_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return completion_response("   ")

    provider = sync_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        provider.generate(
            model="deepseek-summary", messages=[user_text("hi")], max_output_tokens=40
        )

    assert exc_info.value.code == "deepseek_summarize_empty"


def test_generate_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    provider = sync_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        provider.generate(
            model="deepseek-summary", messages=[user_text("hi")], max_output_tokens=40
        )

    assert exc_info.value.code == "deepseek_summarize_http_error"
