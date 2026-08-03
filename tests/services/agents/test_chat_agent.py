"""Pure, in-memory tests for the orchestration loop (``ChatAgent.stream()``).

FakeProvider + FakeTool, zero network, zero DB: the loop's declared event stream
is the whole surface. Cancellation and retry are the worker's engineering and
are covered by the worker integration tests.
"""

from dataclasses import dataclass, field
from typing import Any

import pytest

from app.agent.events import (
    AgentFinal,
    MessageDone,
    ToolCallFinished,
    ToolCallStarted,
)
from app.agent.messages import (
    ImageBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    user_text,
)
from app.agent.provider import ProviderError, ReasoningDelta, StreamDone, TextDelta, ToolCallDone
from app.agent.tools import ToolRegistry, ToolResult, ToolSpec
from app.core.config import get_settings
from app.services.agents.chat_agent import (
    ChatAgent,
    ChatAgentOptions,
    RetryPolicy,
    build_chat_agent,
)
from tests.agent.fake import FakeProvider


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


def make_agent(
    provider: FakeProvider,
    *,
    tools: ToolRegistry | None = None,
    max_tool_calls: int = 4,
) -> ChatAgent:
    return ChatAgent(
        provider=provider,
        model="fake-model",
        reasoning=None,
        tools=tools or ToolRegistry(),
        messages=[user_text("question")],
        max_tool_calls=max_tool_calls,
        retry_policy=RetryPolicy(max_attempts=1),
        tool_backend_names={},
        assistant_metadata=lambda: None,
        system_prompt="sys",
    )


async def collect(agent: ChatAgent) -> list[object]:
    return [event async for event in agent.stream()]


def _image_history() -> list[Message]:
    return [
        Message(
            role="user",
            blocks=[
                ImageBlock(
                    file_id="image-1",
                    filename="diagram.webp",
                    media_type="image/webp",
                    sha256="a" * 64,
                    width=640,
                    height=480,
                    processor_version="image-v1",
                )
            ],
        )
    ]


def _settings_with(**overrides: object):
    return get_settings().model_copy(update=overrides)


def test_build_chat_agent_rejects_image_for_model_removed_from_vision_allowlist() -> None:
    provider = FakeProvider()
    settings = _settings_with(
        openai_api_key="sk-test",
        openai_models="gpt-5-mini",
        openai_vision_models="",
    )

    def resolve(_name: str, *, settings: object) -> FakeProvider:
        return provider

    with pytest.raises(ProviderError) as exc_info:
        build_chat_agent(
            settings=settings,
            history=_image_history(),
            options=ChatAgentOptions(provider_name="openai", model="gpt-5-mini"),
            resolve_provider=resolve,
        )

    assert exc_info.value.code == "openai_image_input_not_supported"
    assert provider.calls == []


async def test_build_chat_agent_allows_image_for_explicit_vision_model() -> None:
    provider = FakeProvider(script=[StreamDone(finish_reason="stop")])
    settings = _settings_with(
        openai_api_key="sk-test",
        openai_models="gpt-5-mini",
        openai_vision_models="gpt-5-mini",
    )

    def resolve(_name: str, *, settings: object) -> FakeProvider:
        return provider

    agent = build_chat_agent(
        settings=settings,
        history=_image_history(),
        options=ChatAgentOptions(provider_name="openai", model="gpt-5-mini"),
        resolve_provider=resolve,
    )

    assert agent.image_count == 1
    await collect(agent)
    assert provider.last_messages is not None
    assert any(isinstance(block, ImageBlock) for block in provider.last_messages[1].blocks)


async def test_multi_tool_turn_yields_events_and_messages() -> None:
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
                StreamDone("stop", usage={"prompt_tokens": 7}, provider_request_id="req-1"),
            ],
        ]
    )
    tool = FakeTool(
        results=[
            ToolResult("evidence one", metadata={"query": "one", "result_count": 1}),
            ToolResult("evidence two", metadata={"query": "two", "result_count": 1}),
        ]
    )

    events = await collect(make_agent(provider, tools=ToolRegistry([tool])))

    assert [type(e).__name__ for e in events] == [
        "ReasoningDelta",
        "MessageDone",
        "ToolCallStarted",
        "ToolCallFinished",
        "ToolCallStarted",
        "ToolCallFinished",
        "MessageDone",
        "TextDelta",
        "MessageDone",
        "AgentFinal",
    ]
    messages = [e.message for e in events if isinstance(e, MessageDone)]
    assert messages == [
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
    started = [e for e in events if isinstance(e, ToolCallStarted)]
    assert [s.arguments for s in started] == [{"query": "one"}, {"query": "two"}]
    finished = [e for e in events if isinstance(e, ToolCallFinished)]
    assert finished[0].metadata == {"query": "one", "result_count": 1}
    assert all(not f.is_error for f in finished)
    final = events[-1]
    assert isinstance(final, AgentFinal)
    assert final.usage == {"prompt_tokens": 7}
    assert final.provider_request_id == "req-1"
    # The second model call replays the first two transcript messages.
    assert provider.calls[1][1:] == messages[:2]


async def test_no_tools_yields_final() -> None:
    provider = FakeProvider(script=[TextDelta("hello"), StreamDone("stop")])

    events = await collect(make_agent(provider))

    assert [type(e).__name__ for e in events] == ["TextDelta", "MessageDone", "AgentFinal"]
    assert isinstance(events[1], MessageDone)
    assert events[1].message == Message(role="assistant", blocks=[TextBlock("hello")])


async def test_unknown_tool_finishes_error_without_started() -> None:
    provider = FakeProvider(
        scripts=[
            [ToolCallDone("call_1", "missing", {}), StreamDone("tool_calls")],
            [TextDelta("fallback"), StreamDone("stop")],
        ]
    )

    events = await collect(make_agent(provider, tools=ToolRegistry()))

    assert not any(isinstance(e, ToolCallStarted) for e in events)
    finished = next(e for e in events if isinstance(e, ToolCallFinished))
    assert finished.is_error is True
    assert finished.metadata["error_code"] == "unknown_tool"


async def test_tool_call_limit_finishes_error_without_started() -> None:
    provider = FakeProvider(
        scripts=[
            [ToolCallDone("call_1", "lookup", {"n": 1}), StreamDone("tool_calls")],
            [ToolCallDone("call_2", "lookup", {"n": 2}), StreamDone("tool_calls")],
            [TextDelta("done"), StreamDone("stop")],
        ]
    )
    tool = FakeTool(results=[ToolResult("first")])

    events = await collect(make_agent(provider, tools=ToolRegistry([tool]), max_tool_calls=1))

    assert tool.calls == [{"n": 1}]
    assert sum(isinstance(e, ToolCallStarted) for e in events) == 1
    errors = [e for e in events if isinstance(e, ToolCallFinished) and e.is_error]
    assert len(errors) == 1
    assert errors[0].metadata["error_code"] == "tool_call_limit"


async def test_tool_exception_becomes_error_result() -> None:
    provider = FakeProvider(
        scripts=[
            [ToolCallDone("call_1", "lookup", {}), StreamDone("tool_calls")],
            [TextDelta("fallback answer"), StreamDone("stop")],
        ]
    )

    events = await collect(make_agent(provider, tools=ToolRegistry([ThrowingTool()])))

    finished = next(e for e in events if isinstance(e, ToolCallFinished))
    assert finished.is_error is True
    assert finished.metadata["error_code"] == "tool_execution_error"
    tool_message = [e.message for e in events if isinstance(e, MessageDone)][1]
    block = tool_message.blocks[0]
    assert isinstance(block, ToolResultBlock)
    assert block.is_error is True


async def test_stream_is_reentrant() -> None:
    # A single-script provider replays the same turn for every call, so two
    # independent stream() runs must produce identical event streams.
    provider = FakeProvider(script=[TextDelta("hi"), StreamDone("stop")])
    agent = make_agent(provider)

    first = [type(e).__name__ for e in await collect(agent)]
    second = [type(e).__name__ for e in await collect(agent)]

    assert first == second == ["TextDelta", "MessageDone", "AgentFinal"]
