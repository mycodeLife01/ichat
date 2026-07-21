"""Kernel single-call primitives: ``stream_model_call`` and ``execute_tool``."""

import asyncio
from typing import Any

import pytest

from app.agent.messages import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
)
from app.agent.primitives import ModelCallResult, execute_tool, stream_model_call
from app.agent.provider import ProviderError, ReasoningDelta, StreamDone, TextDelta, ToolCallDone
from app.agent.tools import ToolResult, ToolSpec
from tests.agent.fake import FakeProvider, RaiseError


async def _drain(provider: FakeProvider) -> list[object]:
    return [
        item
        async for item in stream_model_call(
            provider, model="m", messages=[], reasoning=None, tools=None
        )
    ]


async def test_stream_model_call_forwards_deltas_and_assembles_message() -> None:
    provider = FakeProvider(
        script=[
            ReasoningDelta("think"),
            TextDelta("hello"),
            TextDelta(" world"),
            StreamDone("stop", usage={"prompt_tokens": 3}, provider_request_id="req-9"),
        ]
    )

    items = await _drain(provider)

    assert [type(i).__name__ for i in items] == [
        "ReasoningDelta",
        "TextDelta",
        "TextDelta",
        "ModelCallResult",
    ]
    result = items[-1]
    assert isinstance(result, ModelCallResult)
    assert result.message == Message(
        role="assistant",
        blocks=[ReasoningBlock("think"), TextBlock("hello world")],
    )
    assert result.usage == {"prompt_tokens": 3}
    assert result.provider_request_id == "req-9"


async def test_stream_model_call_buffers_tool_calls_into_message() -> None:
    provider = FakeProvider(
        script=[
            ToolCallDone("call_1", "lookup", {"q": "x"}),
            StreamDone("tool_calls"),
        ]
    )

    items = await _drain(provider)

    # Tool calls are not forwarded as stream items — only the assembled result.
    assert [type(i).__name__ for i in items] == ["ModelCallResult"]
    result = items[0]
    assert isinstance(result, ModelCallResult)
    assert result.message.blocks == [ToolCallBlock("call_1", "lookup", {"q": "x"})]


async def test_stream_model_call_raises_provider_error() -> None:
    provider = FakeProvider(script=[RaiseError("upstream_5xx", "boom")])

    with pytest.raises(ProviderError) as exc:
        await _drain(provider)
    assert exc.value.code == "upstream_5xx"


async def test_stream_model_call_raises_no_finish_when_stream_ends_early() -> None:
    provider = FakeProvider(script=[TextDelta("partial")])

    with pytest.raises(ProviderError) as exc:
        await _drain(provider)
    assert exc.value.code == "no_finish"


class _EchoTool:
    @property
    def name(self) -> str:
        return "echo"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description="echo", parameters={"type": "object"})

    async def execute(self, arguments: dict[str, Any]) -> ToolResult:
        return ToolResult(content=str(arguments))


class _BoomTool:
    @property
    def name(self) -> str:
        return "boom"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description="boom", parameters={"type": "object"})

    async def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raise RuntimeError("kaboom")


class _HangTool:
    @property
    def name(self) -> str:
        return "hang"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description="hang", parameters={"type": "object"})

    async def execute(self, arguments: dict[str, Any]) -> ToolResult:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


async def test_execute_tool_returns_result() -> None:
    result = await execute_tool(_EchoTool(), {"a": 1})
    assert result.is_error is False
    assert result.content == "{'a': 1}"


async def test_execute_tool_wraps_exception() -> None:
    result = await execute_tool(_BoomTool(), {})
    assert result.is_error is True
    assert result.metadata["error_code"] == "tool_execution_error"
    assert result.metadata["message"] == "kaboom"


async def test_execute_tool_propagates_cancellation() -> None:
    task = asyncio.ensure_future(execute_tool(_HangTool(), {}))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
