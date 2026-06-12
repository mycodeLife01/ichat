import json
from typing import Any

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.providers import (
    Finish,
    ProviderError,
    ProviderMessage,
    ReasoningDelta,
    TextDelta,
    ThinkingOptions,
    ToolCallTurn,
    ToolSpec,
)
from app.providers.deepseek import DeepSeekProvider


def make_settings() -> Settings:
    return get_settings()


def sse_body(chunks: list[dict[str, Any]]) -> bytes:
    lines = []
    for chunk in chunks:
        lines.append(f"data: {json.dumps(chunk)}\n\n")
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


async def test_deepseek_provider_streams_text_deltas_and_finish() -> None:
    body = sse_body(
        [
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": None}],
            },
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {"content": " world"}, "finish_reason": None}],
            },
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2},
            },
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path.endswith("/chat/completions")
        assert request.headers["authorization"].startswith("Bearer ")
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert payload["model"] == "deepseek-test"
        return httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/event-stream", "x-request-id": "req-77"},
        )

    transport = httpx.MockTransport(handler)
    provider = DeepSeekProvider(settings=make_settings(), transport=transport)

    chunks = []
    async for chunk in provider.stream(
        model="deepseek-test",
        messages=[ProviderMessage(role="user", content="hi")],
    ):
        chunks.append(chunk)

    assert chunks[:2] == [TextDelta(text="Hello"), TextDelta(text=" world")]
    finish = chunks[2]
    assert isinstance(finish, Finish)
    assert finish.finish_reason == "stop"
    assert finish.usage == {"prompt_tokens": 4, "completion_tokens": 2}
    assert finish.provider_request_id == "req-77"


async def test_deepseek_provider_raises_provider_error_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "server is sad"}})

    transport = httpx.MockTransport(handler)
    provider = DeepSeekProvider(settings=make_settings(), transport=transport)

    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
        ):
            pass

    assert exc_info.value.code == "deepseek_http_error"
    assert "500" in exc_info.value.message


async def test_deepseek_provider_disables_thinking_when_config_false() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [
                    {
                        "id": "1",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"content": "Hi"},
                                "finish_reason": None,
                            }
                        ],
                    },
                    {
                        "id": "1",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop",
                            }
                        ],
                    },
                ]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": False})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    chunks = [
        chunk
        async for chunk in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
        )
    ]

    assert chunks[0] == TextDelta(text="Hi")
    assert captured_payload["thinking"] == {"type": "disabled"}


async def test_deepseek_provider_enables_thinking_when_config_true() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [
                    {
                        "id": "1",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop",
                            }
                        ],
                    },
                ]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": True})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    chunks = [
        chunk
        async for chunk in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
        )
    ]

    assert isinstance(chunks[0], Finish)
    assert captured_payload["thinking"] == {"type": "enabled"}


async def test_deepseek_provider_summarize_returns_message_content() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "Project Plan"}}]},
        )

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    title = await provider.summarize(
        model="deepseek-summary",
        messages=[ProviderMessage(role="user", content="summarize this")],
        max_output_tokens=40,
    )

    assert title == "Project Plan"
    assert captured_payload["model"] == "deepseek-summary"
    assert captured_payload["stream"] is False
    assert captured_payload["thinking"] == {"type": "disabled"}
    assert captured_payload["max_tokens"] == 40
    assert captured_payload["temperature"] == 0.3


async def test_deepseek_provider_summarize_raises_on_empty_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "   "}}]})

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="deepseek-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "deepseek_summarize_empty"


async def test_deepseek_provider_summarize_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="deepseek-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "deepseek_summarize_http_error"
    assert "429" in exc_info.value.message


async def test_deepseek_provider_summarize_raises_on_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down", request=request)

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="deepseek-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "deepseek_summarize_transport_error"


async def test_stream_sends_reasoning_effort_when_thinking_enabled() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [{"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(
        update={"deepseek_thinking_enabled": True, "deepseek_reasoning_effort": "max"}
    )
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    async for _ in provider.stream(
        model="deepseek-test", messages=[ProviderMessage(role="user", content="hi")]
    ):
        pass

    assert captured_payload["thinking"] == {"type": "enabled"}
    assert captured_payload["reasoning_effort"] == "max"


async def test_stream_omits_reasoning_effort_when_thinking_disabled() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [{"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": False})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    async for _ in provider.stream(
        model="deepseek-test", messages=[ProviderMessage(role="user", content="hi")]
    ):
        pass

    assert captured_payload["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in captured_payload


async def test_stream_per_request_thinking_overrides_disabled_settings() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [{"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(
        update={"deepseek_thinking_enabled": False, "deepseek_reasoning_effort": "high"}
    )
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    async for _ in provider.stream(
        model="deepseek-test",
        messages=[ProviderMessage(role="user", content="hi")],
        thinking=ThinkingOptions(enabled=True, reasoning_effort="max"),
    ):
        pass

    assert captured_payload["thinking"] == {"type": "enabled"}
    assert captured_payload["reasoning_effort"] == "max"


async def test_stream_per_request_thinking_disables_despite_enabled_settings() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [{"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": True})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    async for _ in provider.stream(
        model="deepseek-test",
        messages=[ProviderMessage(role="user", content="hi")],
        thinking=ThinkingOptions(enabled=False, reasoning_effort="high"),
    ):
        pass

    assert captured_payload["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in captured_payload


async def test_stream_yields_reasoning_delta_then_text_delta() -> None:
    body = sse_body(
        [
            {"id": "1", "choices": [{"index": 0, "delta": {"reasoning_content": "think"},
                                     "finish_reason": None}]},
            {"id": "1", "choices": [{"index": 0, "delta": {"content": "answer"},
                                     "finish_reason": None}]},
            {"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": True})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    chunks = [
        c
        async for c in provider.stream(
            model="deepseek-test", messages=[ProviderMessage(role="user", content="hi")]
        )
    ]

    assert chunks[0] == ReasoningDelta(text="think")
    assert chunks[1] == TextDelta(text="answer")
    assert isinstance(chunks[2], Finish)


def test_deepseek_count_tokens_uses_official_ratios() -> None:
    provider = DeepSeekProvider(settings=make_settings())
    # 10 English chars at 0.3 tokens/char
    assert provider.count_tokens("a" * 10) == 3
    # 10 Chinese chars at 0.6 tokens/char
    assert provider.count_tokens("中" * 10) == 6
    # Mixed, rounded up: ceil(4*0.3 + 2*0.6) = ceil(2.4) = 3
    assert provider.count_tokens("abcd中文") == 3
    assert provider.count_tokens("") == 0


async def test_stream_with_tools_forwards_deltas_live_and_yields_complete_tool_call_turn() -> (
    None
):
    body = sse_body(
        [
            {
                "id": "1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "need search"},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {"name": "web_search", "arguments": '{"query":'},
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": '"latest news"}'},
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
            },
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["tools"][0]["function"]["name"] == "web_search"
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))
    tools = [ToolSpec(name="web_search", description="search", parameters={"type": "object"})]

    chunks = [
        chunk
        async for chunk in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
            tools=tools,
        )
    ]

    # Reasoning streams live (the worker persists it as it arrives); the turn's
    # tool calls are still delivered as one complete ToolCallTurn at finish.
    assert len(chunks) == 2
    assert isinstance(chunks[0], ReasoningDelta)
    assert chunks[0].text == "need search"
    turn = chunks[1]
    assert isinstance(turn, ToolCallTurn)
    assert turn.reasoning_content == "need search"
    assert turn.tool_calls[0].id == "call_1"
    assert turn.tool_calls[0].name == "web_search"
    assert turn.tool_calls[0].arguments == '{"query":"latest news"}'


async def test_stream_with_tools_streams_final_answer_deltas_live() -> None:
    body = sse_body(
        [
            {
                "id": "1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "thinking"},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "1",
                "choices": [
                    {"index": 0, "delta": {"content": "Hel"}, "finish_reason": None}
                ],
            },
            {
                "id": "1",
                "choices": [
                    {"index": 0, "delta": {"content": "lo"}, "finish_reason": None}
                ],
            },
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))
    tools = [ToolSpec(name="web_search", description="search", parameters={"type": "object"})]

    chunks = [
        chunk
        async for chunk in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
            tools=tools,
        )
    ]

    # A final-answer turn must stream per-chunk deltas (not one aggregate at
    # finish), otherwise the frontend gets the whole reply in a single burst.
    assert len(chunks) == 4
    assert isinstance(chunks[0], ReasoningDelta)
    assert chunks[0].text == "thinking"
    assert isinstance(chunks[1], TextDelta)
    assert chunks[1].text == "Hel"
    assert isinstance(chunks[2], TextDelta)
    assert chunks[2].text == "lo"
    assert isinstance(chunks[3], Finish)
