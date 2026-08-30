import json
from typing import Any

import httpx
import pytest
from openai import AsyncOpenAI, OpenAI

from app.agent.messages import (
    Message,
    ProviderContinuationBlock,
    ReasoningBlock,
    ReasoningKind,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    user_text,
)
from app.agent.provider import ProviderError, ReasoningConfig, ReasoningDelta, StreamDone, TextDelta
from app.agent.providers.openrouter import OpenRouterProvider


def _chunk(delta: dict[str, Any], *, finish: str | None = None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "deepseek/deepseek-chat",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _stream_response(chunks: list[dict[str, Any]]) -> httpx.Response:
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return httpx.Response(
        200,
        content="".join(lines).encode(),
        headers={"content-type": "text/event-stream"},
    )


def _streaming_provider(
    handler: Any,
    *,
    reasoning_outputs: tuple[ReasoningKind, ...] = ("raw",),
    base_url: str = "https://openrouter.test/api/v1",
) -> OpenRouterProvider:
    client = AsyncOpenAI(
        base_url=base_url,
        api_key="test-key",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return OpenRouterProvider(
        api_key="test-key",
        base_url=base_url,
        token_profile="deepseek",
        reasoning_outputs=reasoning_outputs,
        async_client=client,
    )


def _sync_provider(handler: Any) -> OpenRouterProvider:
    client = OpenAI(
        base_url="https://openrouter.test/api/v1",
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    return OpenRouterProvider(
        api_key="test-key",
        base_url="https://openrouter.test/api/v1",
        token_profile="deepseek",
        sync_client=client,
    )


async def test_stream_uses_openrouter_reasoning_body_and_replays_plaintext_reasoning() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return _stream_response([_chunk({}, finish="stop")])

    provider = _streaming_provider(handler)
    history = [
        user_text("look it up"),
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("need current docs"),
                ToolCallBlock(id="call-1", name="search", arguments={"q": "docs"}),
            ],
        ),
        Message(role="user", blocks=[ToolResultBlock("call-1", "result")]),
    ]

    async for _ in provider.stream(
        model="deepseek/deepseek-chat",
        messages=history,
        reasoning=ReasoningConfig(enabled=True, effort="high"),
    ):
        pass

    assert captured["reasoning"] == {"effort": "high"}
    assert "reasoning_effort" not in captured
    assistant = next(message for message in captured["messages"] if message["role"] == "assistant")
    assert assistant["reasoning"] == "need current docs"
    assert "reasoning_content" not in assistant


async def test_stream_maps_disabled_reasoning_to_none_and_reads_both_delta_aliases() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return _stream_response(
            [
                _chunk({"reasoning": "first"}),
                _chunk({"reasoning_content": " second"}),
                _chunk({"content": "answer"}, finish="stop"),
            ]
        )

    provider = _streaming_provider(handler)
    events = [
        event
        async for event in provider.stream(
            model="deepseek/deepseek-chat",
            messages=[user_text("hi")],
            reasoning=ReasoningConfig(enabled=False, effort="high"),
        )
    ]

    assert captured["reasoning"] == {"effort": "none"}
    assert events[:3] == [
        ReasoningDelta(text="first"),
        ReasoningDelta(text=" second"),
        TextDelta(text="answer"),
    ]
    assert isinstance(events[-1], StreamDone)


async def test_stream_classifies_structured_details_and_keeps_opaque_state() -> None:
    details = [
        {
            "type": "reasoning.summary",
            "summary": "Check the latest source",
            "index": 0,
        },
        {
            "type": "reasoning.text",
            "text": "Inspect the source carefully",
            "index": 1,
        },
        {
            "type": "reasoning.encrypted",
            "data": "opaque-ciphertext",
            "id": "reasoning-1",
            "format": "openai-responses-v1",
            "index": 2,
        },
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                _chunk(
                    {
                        "reasoning": "must not be duplicated",
                        "reasoning_details": details,
                    }
                ),
                _chunk({}, finish="stop"),
            ]
        )

    provider = _streaming_provider(
        handler,
        reasoning_outputs=("raw", "summary"),
    )
    events = [
        event
        async for event in provider.stream(
            model="deepseek/deepseek-chat",
            messages=[user_text("hi")],
        )
    ]

    continuation = events[0]
    assert isinstance(continuation, ProviderContinuationBlock)
    assert continuation.owner == "openrouter"
    assert continuation.codec == "reasoning_details.v2"
    assert continuation.scope == "assistant_message"
    assert continuation.payload["reasoning_details"] == details
    assert continuation.payload["replay_key"].startswith("openrouter:v1:")
    assert events[1:3] == [
        ReasoningDelta(text="Check the latest source", kind="summary"),
        ReasoningDelta(text="Inspect the source carefully", kind="raw"),
    ]
    assert not any(
        isinstance(event, ReasoningDelta) and event.text == "must not be duplicated"
        for event in events
    )
    assert isinstance(events[-1], StreamDone)


async def test_stream_classifies_google_gemini_text_details_as_summary() -> None:
    details = [
        {
            "type": "reasoning.text",
            "text": "**Evaluating options**\n\nI'm comparing the available approaches.",
            "format": "google-gemini-v1",
            "index": 0,
        }
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [_chunk({"reasoning_details": details}), _chunk({}, finish="stop")]
        )

    provider = _streaming_provider(
        handler,
        reasoning_outputs=("raw", "summary"),
    )
    events = [
        event
        async for event in provider.stream(
            model="google/gemini-3.7-flash",
            messages=[user_text("hi")],
        )
    ]

    continuation = events[0]
    assert isinstance(continuation, ProviderContinuationBlock)
    assert continuation.codec == "reasoning_details.v2"
    assert continuation.payload["reasoning_details"] == details
    assert continuation.payload["replay_key"].startswith("openrouter:v1:")
    assert events[1] == ReasoningDelta(text=details[0]["text"], kind="summary")


async def test_stream_replays_legacy_structured_reasoning_details_unchanged() -> None:
    captured: dict[str, Any] = {}
    details = [
        {"type": "reasoning.summary", "summary": "Plan", "index": 0},
        {
            "type": "reasoning.encrypted",
            "data": "opaque",
            "signature": "signed",
            "index": 1,
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return _stream_response([_chunk({}, finish="stop")])

    provider = _streaming_provider(
        handler,
        reasoning_outputs=("raw", "summary"),
    )
    history = [
        user_text("look it up"),
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("Plan", kind="summary"),
                ProviderContinuationBlock(
                    owner="openrouter",
                    codec="reasoning_details.v1",
                    scope="assistant_message",
                    payload={"reasoning_details": details},
                ),
                ToolCallBlock("call-1", "search", {"q": "docs"}),
            ],
        ),
        Message(role="user", blocks=[ToolResultBlock("call-1", "result")]),
    ]

    async for _ in provider.stream(
        model="deepseek/deepseek-chat",
        messages=history,
    ):
        pass

    assistant = next(message for message in captured["messages"] if message["role"] == "assistant")
    assert assistant["reasoning_details"] == details
    assert "reasoning" not in assistant
    assert "reasoning_content" not in assistant


@pytest.mark.parametrize(
    ("target_model", "target_base_url", "expects_replay"),
    [
        ("x-ai/grok", "https://openrouter.test/api/v1", True),
        ("google/gemini", "https://openrouter.test/api/v1", False),
        ("x-ai/grok", "https://other-openrouter.test/api/v1", False),
    ],
)
async def test_stream_replays_v2_details_only_for_the_creating_endpoint(
    target_model: str,
    target_base_url: str,
    expects_replay: bool,
) -> None:
    details = [
        {
            "type": "reasoning.encrypted",
            "data": "opaque",
            "format": "xai-responses-v1",
            "index": 0,
        }
    ]

    def source_handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [_chunk({"reasoning_details": details}), _chunk({}, finish="stop")]
        )

    source = _streaming_provider(
        source_handler,
        base_url="https://openrouter.test/api/v1/",
    )
    source_events = [
        event
        async for event in source.stream(
            model="x-ai/grok",
            messages=[user_text("source")],
        )
    ]
    continuation = source_events[0]
    assert isinstance(continuation, ProviderContinuationBlock)
    assert continuation.codec == "reasoning_details.v2"

    captured: dict[str, Any] = {}

    def target_handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return _stream_response([_chunk({}, finish="stop")])

    target = _streaming_provider(target_handler, base_url=target_base_url)
    history = [
        user_text("source"),
        Message(
            role="assistant",
            blocks=[continuation, TextBlock("source answer")],
        ),
        user_text("follow up"),
    ]
    async for _ in target.stream(model=target_model, messages=history):
        pass

    assistant = next(message for message in captured["messages"] if message["role"] == "assistant")
    if expects_replay:
        assert assistant["reasoning_details"] == details
    else:
        assert "reasoning_details" not in assistant


async def test_stream_classifies_foreign_encrypted_payload_error_without_leaking_body() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={
                "error": {
                    "message": (
                        "Your request contains encrypted reasoning or compaction content "
                        "that was produced under a different model. Encrypted payloads can "
                        "only be replayed to the endpoint that created them."
                    ),
                    "code": 404,
                    "metadata": {"pinned_endpoint_slug": "secret-endpoint"},
                }
            },
        )

    provider = _streaming_provider(handler)
    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(model="google/gemini", messages=[user_text("hi")]):
            pass

    assert exc_info.value.code == "openrouter_continuation_incompatible"
    assert exc_info.value.message == (
        "OpenRouter continuation state is incompatible with the selected model"
    )
    assert "secret-endpoint" not in exc_info.value.message


async def test_stream_classifies_plaintext_as_summary_only_for_summary_only_route() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [_chunk({"reasoning": "Concise explanation"}), _chunk({}, finish="stop")]
        )

    provider = _streaming_provider(handler, reasoning_outputs=("summary",))
    events = [
        event
        async for event in provider.stream(
            model="provider/model",
            messages=[user_text("hi")],
        )
    ]

    assert events[0] == ReasoningDelta(text="Concise explanation", kind="summary")


async def test_stream_keeps_all_typed_details_when_route_declaration_is_conservative() -> None:
    details = [
        {"type": "reasoning.text", "text": "Full reasoning", "index": 0},
        {"type": "reasoning.summary", "summary": "Short summary", "index": 1},
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [_chunk({"reasoning_details": details}), _chunk({}, finish="stop")]
        )

    provider = _streaming_provider(handler, reasoning_outputs=("summary",))
    events = [
        event
        async for event in provider.stream(
            model="provider/model",
            messages=[user_text("hi")],
        )
    ]

    continuation = events[0]
    assert isinstance(continuation, ProviderContinuationBlock)
    assert continuation.codec == "reasoning_details.v2"
    assert continuation.payload["reasoning_details"] == details
    assert continuation.payload["replay_key"].startswith("openrouter:v1:")
    assert events[1:3] == [
        ReasoningDelta(text="Full reasoning", kind="raw"),
        ReasoningDelta(text="Short summary", kind="summary"),
    ]


async def test_stream_rejects_malformed_reasoning_details() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [_chunk({"reasoning_details": {"type": "reasoning.text"}})]
        )

    provider = _streaming_provider(handler)

    with pytest.raises(ProviderError) as exc:
        async for _ in provider.stream(
            model="provider/model",
            messages=[user_text("hi")],
        ):
            pass
    assert exc.value.code == "openrouter_invalid_reasoning_details"


def test_generate_uses_openrouter_max_tokens_and_reasoning_body() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-2",
                "object": "chat.completion",
                "created": 0,
                "model": "deepseek/deepseek-chat",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Title"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    provider = _sync_provider(handler)
    result = provider.generate(
        model="deepseek/deepseek-chat",
        messages=[user_text("summarize")],
        reasoning=ReasoningConfig(enabled=True, effort="max"),
        max_output_tokens=40,
    )

    assert result == "Title"
    assert captured["max_tokens"] == 40
    assert "max_completion_tokens" not in captured
    assert captured["reasoning"] == {"effort": "max"}


def test_deepseek_token_profile_is_independent_of_openrouter_transport() -> None:
    provider = OpenRouterProvider(
        api_key="test-key",
        base_url="https://openrouter.test/api/v1",
        token_profile="deepseek",
    )

    assert provider.name == "openrouter"
    assert provider.count_tokens("a" * 10) == 3
    assert provider.count_tokens("中" * 10) == 6
