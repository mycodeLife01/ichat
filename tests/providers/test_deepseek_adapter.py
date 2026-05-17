import json
from typing import Any

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.providers import Finish, ProviderError, ProviderMessage, TextDelta
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
