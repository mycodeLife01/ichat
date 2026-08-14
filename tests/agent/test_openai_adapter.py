"""OpenAI adapter tests driving the openai SDK through an injected mock
transport, mirroring the DeepSeek adapter tests. The interesting deltas from
DeepSeek: tool history replays without tools registered, reasoning_effort is a
typed top-level param gated by model family, and the sync path uses
``max_completion_tokens`` with no pinned temperature.
"""

import json
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest
from openai import APIConnectionError, AsyncOpenAI, OpenAI

from app.agent.messages import (
    DocumentBlock,
    ImageBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    user_text,
)
from app.agent.provider import (
    ImageInputError,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    ResolvedImageInput,
    StreamDone,
    TextDelta,
    ToolCallDone,
)
from app.agent.providers.openai import OpenAIProvider, supports_reasoning_control
from app.agent.tools.base import ToolSpec


class _ImageResolver:
    def __init__(self, *, fail: ImageInputError | None = None) -> None:
        self.calls: list[tuple[ImageBlock, ...]] = []
        self.fail = fail
        self.counter = 0

    async def resolve(self, images: tuple[ImageBlock, ...]) -> dict[str, ResolvedImageInput]:
        self.calls.append(images)
        if self.fail is not None:
            raise self.fail
        self.counter += 1
        return {
            image.file_id: ResolvedImageInput(
                file_id=image.file_id,
                url=f"https://preview.invalid/{self.counter}/{image.file_id}",
            )
            for image in images
        }


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


def _image(file_id: str = "file-1", *, filename: str = "chart.webp") -> ImageBlock:
    return ImageBlock(
        file_id=file_id,
        filename=filename,
        media_type="image/webp",
        sha256=file_id.ljust(64, "0"),
        width=640,
        height=480,
        processor_version="image-v1",
        warnings=("animated_first_frame",) if filename.endswith(".webp") else (),
    )


async def test_stream_projects_mixed_image_content_in_original_order_and_deduplicates() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return stream_response([chunk({}, finish="stop")])

    image = _image()
    duplicate = _image()
    resolver = _ImageResolver()
    provider = streaming_provider(handler)
    message = Message(
        role="user",
        blocks=[
            TextBlock("inspect"),
            image,
            DocumentBlock(
                file_id="doc-1",
                filename="notes.txt",
                media_type="text/plain",
                text="reference",
                sha256="b" * 64,
                extractor_version="text-v1",
            ),
            duplicate,
        ],
    )

    async for _ in provider.stream(
        model="gpt-5-mini",
        messages=[message],
        image_resolver=resolver,
    ):
        pass

    assert len(resolver.calls) == 1
    assert resolver.calls[0] == (image,)
    parts = captured["messages"][0]["content"]
    assert [part["type"] for part in parts] == [
        "text",
        "text",
        "image_url",
        "text",
        "text",
        "text",
        "image_url",
        "text",
    ]
    assert parts[2]["image_url"]["detail"] == "high"
    assert parts[2]["image_url"]["url"] == parts[6]["image_url"]["url"]
    assert '"attachment_index":1' in parts[1]["text"]
    assert '"attachment_index":3' in parts[5]["text"]
    assert "animated_first_frame" in parts[1]["text"]


async def test_stream_resolves_images_again_for_each_model_call() -> None:
    captured_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        content = payload["messages"][0]["content"]
        captured_urls.append(
            next(item["image_url"]["url"] for item in content if item["type"] == "image_url")
        )
        return stream_response([chunk({}, finish="stop")])

    resolver = _ImageResolver()
    provider = streaming_provider(handler)
    image = _image()
    for _ in range(2):
        async for _ in provider.stream(
            model="gpt-5-mini",
            messages=[Message(role="user", blocks=[image])],
            image_resolver=resolver,
        ):
            pass

    assert len(resolver.calls) == 2
    assert captured_urls == [
        "https://preview.invalid/1/file-1",
        "https://preview.invalid/2/file-1",
    ]


async def test_image_resolution_failure_makes_zero_sdk_requests_and_preserves_retryability(
) -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return stream_response([chunk({}, finish="stop")])

    resolver = _ImageResolver(
        fail=ImageInputError(
            code="image_input_unavailable",
            message="temporary signer outage",
            retryable=True,
        )
    )
    provider = streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="gpt-5-mini",
            messages=[Message(role="user", blocks=[_image()])],
            image_resolver=resolver,
        ):
            pass

    assert requests == 0
    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is True
    assert "temporary signer outage" not in exc_info.value.message


async def test_duplicate_image_snapshot_mismatch_fails_before_resolver_or_sdk() -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return stream_response([chunk({}, finish="stop")])

    first = _image()
    second = _image()
    second = ImageBlock(**{**second.__dict__, "sha256": "c" * 64})
    resolver = _ImageResolver()
    provider = streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="gpt-5-mini",
            messages=[Message(role="user", blocks=[first, second])],
            image_resolver=resolver,
        ):
            pass

    assert requests == 0
    assert resolver.calls == []
    assert exc_info.value.code == "image_input_snapshot_mismatch"


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
    assert "server is sad" in exc_info.value.message


async def test_stream_image_http_error_does_not_leak_signed_url() -> None:
    signed_url = (
        "https://preview.example.test/image.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&"
        "X-Amz-Signature=secret"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            json={"error": {"message": f"preview failed: {signed_url}"}},
        )

    provider = streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="gpt-5-mini",
            messages=[Message(role="user", blocks=[_image()])],
            image_resolver=_ImageResolver(),
        ):
            pass

    assert exc_info.value.code == "openai_http_error"
    assert exc_info.value.message == "OpenAI returned 500 while processing image input"
    assert signed_url not in exc_info.value.message


class _RaisingAsyncClient:
    def __init__(self, error: Exception) -> None:
        self.chat = SimpleNamespace(completions=_RaisingCompletions(error))


class _RaisingCompletions:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def create(self, **_: Any) -> Any:
        raise self._error


async def test_stream_image_transport_error_does_not_leak_signed_url() -> None:
    signed_url = (
        "https://preview.example.test/image.webp?X-Amz-Credential=secret&"
        "X-Amz-Signature=secret"
    )
    error = APIConnectionError(
        message=f"transport failed for {signed_url}",
        request=httpx.Request("POST", signed_url),
    )
    client = cast(AsyncOpenAI, _RaisingAsyncClient(error))
    provider = OpenAIProvider(
        api_key="test-key",
        base_url="http://openai.test/v1",
        async_client=client,
    )

    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="gpt-5-mini",
            messages=[Message(role="user", blocks=[_image()])],
            image_resolver=_ImageResolver(),
        ):
            pass

    assert exc_info.value.code == "openai_transport_error"
    assert exc_info.value.message == "OpenAI request failed while processing image input"
    assert signed_url not in exc_info.value.message


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
