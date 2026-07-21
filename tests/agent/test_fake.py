import pytest

from app.agent.messages import user_text
from app.agent.provider import (
    Provider,
    ProviderCapabilities,
    ProviderError,
    ReasoningConfig,
    StreamDone,
    TextDelta,
)
from app.agent.tools.base import ToolSpec
from tests.agent.fake import FakeProvider, RaiseError


async def test_fake_provider_yields_scripted_events() -> None:
    provider = FakeProvider(
        script=[
            TextDelta(text="Hello"),
            TextDelta(text=" world"),
            StreamDone(finish_reason="stop"),
        ]
    )

    events = [
        event
        async for event in provider.stream(model="fake", messages=[user_text("hi")])
    ]

    assert events == [
        TextDelta(text="Hello"),
        TextDelta(text=" world"),
        StreamDone(finish_reason="stop"),
    ]


async def test_fake_provider_records_call_arguments() -> None:
    provider = FakeProvider(script=[StreamDone(finish_reason="stop")])
    reasoning = ReasoningConfig(enabled=True, effort="high")
    tools = [ToolSpec(name="web_search", description="search", parameters={"type": "object"})]

    async for _ in provider.stream(
        model="fake", messages=[user_text("hi")], reasoning=reasoning, tools=tools
    ):
        pass

    assert provider.last_reasoning == reasoning
    assert provider.last_tools == tools
    assert provider.last_messages == [user_text("hi")]


async def test_fake_provider_raises_when_scripted() -> None:
    provider = FakeProvider(script=[RaiseError(code="boom", message="bad")])

    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(model="fake", messages=[user_text("hi")]):
            pass

    assert exc_info.value.code == "boom"


def test_fake_provider_generate_returns_configured_text() -> None:
    provider = FakeProvider(generate_result="A concise title")

    result = provider.generate(model="fake", messages=[user_text("hi")], max_output_tokens=40)

    assert result == "A concise title"


def test_fake_provider_generate_can_raise() -> None:
    provider = FakeProvider(
        generate_result=ProviderError(code="summary_failed", message="boom")
    )

    with pytest.raises(ProviderError) as exc_info:
        provider.generate(model="fake", messages=[user_text("hi")], max_output_tokens=40)

    assert exc_info.value.code == "summary_failed"


def test_fake_provider_is_a_provider_with_default_capabilities() -> None:
    provider = FakeProvider()
    assert isinstance(provider, Provider)
    assert provider.capabilities == ProviderCapabilities(
        supports_tool_history=True, supports_reasoning=True
    )
    # Default conservative token estimate from the Provider base class.
    assert provider.count_tokens("a" * 10) == 5
    assert provider.count_tokens("中" * 10) == 10
