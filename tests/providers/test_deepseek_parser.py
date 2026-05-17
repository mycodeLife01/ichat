import pytest

from app.providers import Finish, ProviderError, TextDelta
from app.providers.deepseek_parser import parse_sse_line


def test_parse_sse_line_returns_text_delta_for_content_chunk() -> None:
    line = (
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hello"},'
        '"finish_reason":null}]}'
    )

    result = parse_sse_line(line)

    assert result == TextDelta(text="Hello")


def test_parse_sse_line_returns_finish_when_finish_reason_present() -> None:
    line = (
        'data: {"id":"y","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":3,"completion_tokens":2}}'
    )

    result = parse_sse_line(line)

    assert isinstance(result, Finish)
    assert result.finish_reason == "stop"
    assert result.usage == {"prompt_tokens": 3, "completion_tokens": 2}


def test_parse_sse_line_returns_none_for_done_marker() -> None:
    assert parse_sse_line("data: [DONE]") is None


def test_parse_sse_line_returns_none_for_non_data_line() -> None:
    assert parse_sse_line("event: ping") is None
    assert parse_sse_line("") is None
    assert parse_sse_line(":heartbeat") is None


def test_parse_sse_line_returns_none_for_empty_delta_without_finish() -> None:
    line = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}'
    assert parse_sse_line(line) is None


def test_parse_sse_line_raises_provider_error_on_invalid_json() -> None:
    with pytest.raises(ProviderError) as exc_info:
        parse_sse_line("data: {not valid")

    assert exc_info.value.code == "deepseek_invalid_json"
