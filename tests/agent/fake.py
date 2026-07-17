import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass

from app.agent.messages import Message
from app.agent.provider import (
    Provider,
    ProviderCapabilities,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    StreamDone,
    StreamEvent,
    TextDelta,
    ToolCallDone,
)
from app.agent.tools.base import ToolSpec


@dataclass(frozen=True)
class RaiseError:
    code: str
    message: str


@dataclass(frozen=True)
class Sleep:
    seconds: float


ScriptItem = TextDelta | ReasoningDelta | ToolCallDone | StreamDone | RaiseError | Sleep


class FakeProvider(Provider):
    """In-memory provider that replays a scripted event stream.

    The kernel's highest-value test seam: zero network, zero DB, deterministic.
    Records the last call's arguments so tests can assert what the orchestration
    layer sent.
    """

    def __init__(
        self,
        *,
        script: Sequence[ScriptItem] = (),
        name: str = "fake",
        capabilities: ProviderCapabilities | None = None,
        generate_result: str | ProviderError = "Fake Title",
    ) -> None:
        self._script = list(script)
        self._name = name
        self._capabilities = capabilities or ProviderCapabilities(
            supports_tool_history=True, supports_reasoning=True
        )
        self._generate_result = generate_result
        self.last_reasoning: ReasoningConfig | None = None
        self.last_tools: list[ToolSpec] | None = None
        self.last_messages: list[Message] | None = None

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> ProviderCapabilities:
        return self._capabilities

    async def stream(
        self,
        *,
        model: str,
        messages: list[Message],
        reasoning: ReasoningConfig | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        self.last_reasoning = reasoning
        self.last_tools = tools
        self.last_messages = messages
        for item in self._script:
            if isinstance(item, RaiseError):
                raise ProviderError(code=item.code, message=item.message)
            if isinstance(item, Sleep):
                await asyncio.sleep(item.seconds)
                continue
            yield item

    def generate(
        self,
        *,
        model: str,
        messages: list[Message],
        max_output_tokens: int,
        reasoning: ReasoningConfig | None = None,
    ) -> str:
        if isinstance(self._generate_result, ProviderError):
            raise self._generate_result
        return self._generate_result
