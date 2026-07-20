import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.agent.events import RunEvent
from app.agent.messages import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    user_text,
)
from app.agent.provider import ReasoningDelta, StreamDone, TextDelta, ToolCallDone
from app.agent.runtime import AgentRunner, CancellationToken, RunConfig
from app.agent.tools import ToolRegistry, ToolResult, ToolSpec
from tests.agent.fake import FakeProvider, RaiseError, Sleep


class FakeSink:
    def __init__(self, on_event: Callable[[RunEvent], None] | None = None) -> None:
        self.events: list[RunEvent] = []
        self._on_event = on_event

    async def emit(self, event: RunEvent) -> None:
        self.events.append(event)
        if self._on_event is not None:
            self._on_event(event)


@dataclass
class FakeTool:
    results: list[ToolResult]
    calls: list[dict[str, Any]] = field(default_factory=list)

    @property
    def name(self) -> str:
        return "lookup"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.name,
            description="Look up evidence",
            parameters={"type": "object"},
        )

    async def execute(self, arguments: dict[str, Any]) -> ToolResult:
        self.calls.append(arguments)
        return self.results[len(self.calls) - 1]


class ThrowingTool:
    @property
    def name(self) -> str:
        return "lookup"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description="Lookup", parameters={"type": "object"})

    async def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raise RuntimeError("lookup exploded")


class BlockingTool:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = False

    @property
    def name(self) -> str:
        return "lookup"

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description="Lookup", parameters={"type": "object"})

    async def execute(self, arguments: dict[str, Any]) -> ToolResult:
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        raise AssertionError("unreachable")


def config(*, tools: ToolRegistry, max_tool_calls: int = 4, attempts: int = 1) -> RunConfig:
    return RunConfig(
        messages=[user_text("question")],
        model="fake-model",
        reasoning=None,
        tools=tools,
        max_tool_calls=max_tool_calls,
        max_provider_attempts=attempts,
    )


async def test_runner_executes_multi_tool_turn_and_returns_transcript() -> None:
    provider = FakeProvider(
        scripts=[
            [
                ReasoningDelta("need evidence"),
                ToolCallDone("call_1", "lookup", {"query": "one"}),
                ToolCallDone("call_2", "lookup", {"query": "two"}),
                StreamDone("tool_calls"),
            ],
            [
                TextDelta("final answer"),
                StreamDone(
                    "stop",
                    usage={"prompt_tokens": 7},
                    provider_request_id="req-1",
                ),
            ],
        ]
    )
    tool = FakeTool(
        results=[
            ToolResult("evidence one", metadata={"query": "one", "result_count": 1}),
            ToolResult("evidence two", metadata={"query": "two", "result_count": 1}),
        ]
    )
    sink = FakeSink()

    result = await AgentRunner(provider, initial_seq=1).run(
        config(tools=ToolRegistry([tool])),
        sink,
        CancellationToken(),
    )

    assert result.status == "succeeded"
    assert result.usage == {"prompt_tokens": 7}
    assert result.provider_request_id == "req-1"
    assert tool.calls == [{"query": "one"}, {"query": "two"}]
    assert len(provider.calls) == 2
    assert provider.calls[1][1:] == result.transcript[:2]
    assert result.transcript == [
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("need evidence"),
                ToolCallBlock("call_1", "lookup", {"query": "one"}),
                ToolCallBlock("call_2", "lookup", {"query": "two"}),
            ],
        ),
        Message(
            role="user",
            blocks=[
                ToolResultBlock("call_1", "evidence one"),
                ToolResultBlock("call_2", "evidence two"),
            ],
        ),
        Message(role="assistant", blocks=[TextBlock("final answer")]),
    ]
    assert [event.type for event in sink.events] == [
        "reasoning_delta",
        "tool_call_started",
        "tool_call_succeeded",
        "tool_call_started",
        "tool_call_succeeded",
        "text_delta",
    ]
    assert [event.seq for event in sink.events] == list(range(2, 8))
    assert sink.events[2].payload["metadata"] == {"query": "one", "result_count": 1}


async def test_runner_cancels_before_first_delta_without_calling_provider() -> None:
    provider = FakeProvider(script=[TextDelta("never"), StreamDone("stop")])
    token = CancellationToken()
    token.cancel()
    sink = FakeSink()

    result = await AgentRunner(provider).run(
        config(tools=ToolRegistry()),
        sink,
        token,
    )

    assert result.status == "cancelled"
    assert result.transcript == []
    assert provider.calls == []
    assert sink.events == []


async def test_runner_cancels_mid_stream_after_emitted_delta() -> None:
    token = CancellationToken()
    provider = FakeProvider(
        script=[TextDelta("partial"), Sleep(30), TextDelta("never"), StreamDone("stop")]
    )
    sink = FakeSink(
        on_event=lambda event: token.cancel() if event.type == "text_delta" else None
    )

    result = await AgentRunner(provider).run(
        config(tools=ToolRegistry()),
        sink,
        token,
    )

    assert result.status == "cancelled"
    assert result.transcript == []
    assert [(event.type, event.payload) for event in sink.events] == [
        ("text_delta", {"text": "partial"})
    ]


async def test_runner_cancels_tool_execution() -> None:
    provider = FakeProvider(
        script=[
            ToolCallDone("call_1", "lookup", {"query": "one"}),
            StreamDone("tool_calls"),
        ]
    )
    tool = BlockingTool()
    token = CancellationToken()
    sink = FakeSink()
    task = asyncio.create_task(
        AgentRunner(provider).run(
            config(tools=ToolRegistry([tool])),
            sink,
            token,
        )
    )

    await asyncio.wait_for(tool.started.wait(), timeout=1)
    token.cancel()
    result = await asyncio.wait_for(task, timeout=1)

    assert result.status == "cancelled"
    assert result.transcript == [
        Message(
            role="assistant",
            blocks=[ToolCallBlock("call_1", "lookup", {"query": "one"})],
        )
    ]
    assert tool.cancelled is True
    assert [event.type for event in sink.events] == ["tool_call_started"]


async def test_runner_returns_provider_error_after_configured_attempts() -> None:
    provider = FakeProvider(
        scripts=[
            [RaiseError("upstream_5xx", "first")],
            [RaiseError("upstream_5xx", "second")],
        ]
    )

    result = await AgentRunner(provider).run(
        config(tools=ToolRegistry(), attempts=2),
        FakeSink(),
        CancellationToken(),
    )

    assert result.status == "failed"
    assert result.error is not None
    assert result.error.code == "upstream_5xx"
    assert result.error.message == "second"
    assert len(provider.calls) == 2


async def test_runner_turns_tool_exception_into_failed_result_and_continues() -> None:
    provider = FakeProvider(
        scripts=[
            [ToolCallDone("call_1", "lookup", {}), StreamDone("tool_calls")],
            [TextDelta("fallback answer"), StreamDone("stop")],
        ]
    )
    sink = FakeSink()

    result = await AgentRunner(provider).run(
        config(tools=ToolRegistry([ThrowingTool()])),
        sink,
        CancellationToken(),
    )

    assert result.status == "succeeded"
    tool_result = result.transcript[1].blocks[0]
    assert isinstance(tool_result, ToolResultBlock)
    assert tool_result.is_error is True
    assert "tool_execution_error" in tool_result.content
    failed = next(event for event in sink.events if event.type == "tool_call_failed")
    assert failed.payload["metadata"] == {
        "error_code": "tool_execution_error",
        "message": "lookup exploded",
    }


async def test_runner_enforces_tool_call_limit_without_stopping_answer() -> None:
    provider = FakeProvider(
        scripts=[
            [ToolCallDone("call_1", "lookup", {"n": 1}), StreamDone("tool_calls")],
            [ToolCallDone("call_2", "lookup", {"n": 2}), StreamDone("tool_calls")],
            [TextDelta("done"), StreamDone("stop")],
        ]
    )
    tool = FakeTool(results=[ToolResult("first")])
    sink = FakeSink()

    result = await AgentRunner(provider).run(
        config(tools=ToolRegistry([tool]), max_tool_calls=1),
        sink,
        CancellationToken(),
    )

    assert result.status == "succeeded"
    assert tool.calls == [{"n": 1}]
    limited = result.transcript[3].blocks[0]
    assert isinstance(limited, ToolResultBlock)
    assert limited.is_error is True
    assert "tool_call_limit" in limited.content
    assert [event.type for event in sink.events].count("tool_call_started") == 1
    assert [event.type for event in sink.events].count("tool_call_failed") == 1
