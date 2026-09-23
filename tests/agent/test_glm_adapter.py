"""GLM adapter tests driving the openai SDK through an injected mock
transport (the SDK accepts a custom ``http_client``), so no network is touched.
"""

import json
from collections.abc import Mapping, Sequence
from typing import Any

import httpx
import pytest
from openai import AsyncOpenAI, OpenAI

from app.agent.messages import (
    ImageBlock,
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
    ResolvedImageInput,
    StreamDone,
    TextDelta,
    ToolCallDone,
)
from app.agent.providers.glm import GLMProvider
from app.agent.tools.base import ToolSpec


def _glm(**clients: Any) -> GLMProvider:
    return GLMProvider(api_key="test-key", base_url="http://glm.test/v1", **clients)


def sse_body(chunks: list[dict[str, Any]]) -> bytes:
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def chunk(delta: dict[str, Any], *, finish: str | None = None) -> dict:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "glm-test",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def streaming_provider(handler) -> GLMProvider:
    client = AsyncOpenAI(
        base_url="http://glm.test/v1",
        api_key="test-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return _glm(async_client=client)


def sync_provider(handler) -> GLMProvider:
    client = OpenAI(
        base_url="http://glm.test/v1",
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return _glm(sync_client=client)


def stream_response(chunks: list[dict[str, Any]]) -> httpx.Response:
    return httpx.Response(
        200,
        content=sse_body(chunks),
        headers={"content-type": "text/event-stream"},
    )


async def test_stream_text_and_usage_keeps_stream_options() -> None:
    # Plan D3 status lock: GLM still receives the shared stream_options until
    # the real-upstream smoke proves otherwise.
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response(
            [
                chunk({"content": "Hello"}),
                chunk({}, finish="stop"),
            ]
        )

    provider = streaming_provider(handler)
    events = [
        event
        async for event in provider.stream(model="glm-test", messages=[user_text("hi")])
    ]

    assert [event for event in events if isinstance(event, TextDelta)] == [
        TextDelta(text="Hello")
    ]
    done = events[-1]
    assert isinstance(done, StreamDone)
    assert done.finish_reason == "stop"
    assert captured["stream_options"] == {"include_usage": True}


async def test_stream_reasoning_content_before_text_as_raw() -> None:
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
        async for event in provider.stream(model="glm-test", messages=[user_text("hi")])
    ]

    assert events[0] == ReasoningDelta(text="think", kind="raw")
    assert events[1] == TextDelta(text="answer")
    assert isinstance(events[2], StreamDone)


async def test_stream_sends_thinking_enabled_clear_thinking_false_and_effort() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="glm-test",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=True, effort="low"),
    ):
        pass

    assert captured["thinking"] == {"type": "enabled", "clear_thinking": False}
    assert captured["reasoning_effort"] == "low"


async def test_stream_reasoning_none_defaults_to_enabled_without_effort() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(model="glm-test", messages=[user_text("hi")]):
        pass

    assert captured["thinking"] == {"type": "enabled", "clear_thinking": False}
    assert "reasoning_effort" not in captured


async def test_stream_disables_thinking_and_omits_effort() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="glm-test",
        messages=[user_text("hi")],
        reasoning=ReasoningConfig(enabled=False, effort="high"),
    ):
        pass

    assert captured["thinking"] == {"type": "disabled", "clear_thinking": False}
    assert "reasoning_effort" not in captured


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


async def test_stream_replays_reasoning_content_with_tool_history() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response(
            [
                chunk(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_2",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": '{"query":"more"}',
                                },
                            }
                        ]
                    }
                ),
                chunk({}, finish="tool_calls"),
            ]
        )

    provider = streaming_provider(handler)
    tools = [ToolSpec(name="web_search", description="search", parameters={"type": "object"})]
    events = [
        event
        async for event in provider.stream(
            model="glm-test", messages=_history_with_tools(), tools=tools
        )
    ]

    assistant_with_calls = [m for m in captured["messages"] if m.get("tool_calls")]
    assert assistant_with_calls and assistant_with_calls[0]["reasoning_content"] == (
        "need current docs"
    )
    assert "tool" in [m["role"] for m in captured["messages"]]
    assert captured["tools"][0]["function"]["name"] == "web_search"
    call = events[0]
    assert isinstance(call, ToolCallDone)
    assert call.arguments == {"query": "more"}


async def test_stream_strips_tool_history_when_no_tools_registered() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    provider = streaming_provider(handler)
    async for _ in provider.stream(model="glm-test", messages=_history_with_tools()):
        pass

    messages = captured["messages"]
    assert all(m["role"] != "tool" for m in messages)
    assert all(not m.get("tool_calls") for m in messages)
    assistant = [m for m in messages if m["role"] == "assistant"]
    assert len(assistant) == 1
    assert assistant[0]["content"] == "Final answer [1]"


class ImageResolver:
    def __init__(self, url: str) -> None:
        self.url = url
        self.requested: list[str] = []

    async def resolve(
        self, images: Sequence[ImageBlock]
    ) -> Mapping[str, ResolvedImageInput]:
        self.requested.extend(block.file_id for block in images)
        return {
            block.file_id: ResolvedImageInput(file_id=block.file_id, url=self.url)
            for block in images
        }


async def test_image_part_keeps_detail_high() -> None:
    # Plan D3 status lock: the shared image encoding stays untouched until the
    # real-upstream smoke proves GLM rejects the extra field.
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({"content": "a chart"}), chunk({}, finish="stop")])

    image = ImageBlock(
        file_id="file-1",
        filename="chart.webp",
        media_type="image/webp",
        sha256="a" * 64,
        width=640,
        height=480,
        processor_version="image-v1",
    )
    resolver = ImageResolver("https://preview.test/signed/chart.webp")
    provider = streaming_provider(handler)
    async for _ in provider.stream(
        model="glm-test",
        messages=[Message(role="user", blocks=[image])],
        image_resolver=resolver,
    ):
        pass

    user_message = captured["messages"][-1]
    assert user_message["content"][1]["image_url"] == {
        "url": "https://preview.test/signed/chart.webp",
        "detail": "high",
    }
    assert resolver.requested == ["file-1"]


async def test_stream_raises_provider_error_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "1002", "message": "bad key"}})

    provider = streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(model="glm-test", messages=[user_text("hi")]):
            pass

    assert exc_info.value.code == "glm_http_error"


def completion_response(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-2",
            "object": "chat.completion",
            "created": 0,
            "model": "glm-summary",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        },
    )


def test_generate_sends_glm_defaults() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return completion_response("Project Plan")

    provider = sync_provider(handler)
    title = provider.generate(
        model="glm-summary", messages=[user_text("summarize")], max_output_tokens=40
    )

    assert title == "Project Plan"
    assert captured["max_tokens"] == 40
    assert captured["temperature"] == 0.3
    assert captured["thinking"] == {"type": "enabled", "clear_thinking": False}
    assert "reasoning_effort" not in captured


def test_generate_raises_on_empty_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return completion_response("   ")

    provider = sync_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        provider.generate(model="glm-summary", messages=[user_text("hi")], max_output_tokens=40)

    assert exc_info.value.code == "glm_summarize_empty"


def test_generate_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    provider = sync_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        provider.generate(model="glm-summary", messages=[user_text("hi")], max_output_tokens=40)

    assert exc_info.value.code == "glm_summarize_http_error"


def test_capabilities_and_token_profile() -> None:
    provider = _glm()
    assert provider.name == "glm"
    assert provider.capabilities.supports_tool_history is False
    assert provider.capabilities.supports_reasoning is True
    assert provider.count_tokens("a" * 10) == 5
    assert provider.count_tokens("中" * 10) == 10
