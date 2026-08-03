import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass

from app.agent.messages import Message
from app.agent.provider import (
    ImageInputResolver,
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
    retryable: bool = False


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
        scripts: Sequence[Sequence[ScriptItem]] | None = None,
        name: str = "fake",
        capabilities: ProviderCapabilities | None = None,
        generate_result: str | ProviderError = "Fake Title",
    ) -> None:
        if script and scripts is not None:
            raise ValueError("Pass either script or scripts, not both")
        self._script = list(script)
        self._scripts = [list(items) for items in scripts] if scripts is not None else None
        self._name = name
        self._capabilities = capabilities or ProviderCapabilities(
            supports_tool_history=True, supports_reasoning=True
        )
        self._generate_result = generate_result
        self.last_reasoning: ReasoningConfig | None = None
        self.last_tools: list[ToolSpec] | None = None
        self.last_image_resolver: ImageInputResolver | None = None
        self.last_messages: list[Message] | None = None
        self.calls: list[list[Message]] = []

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
        image_resolver: ImageInputResolver | None = None,
    ) -> AsyncIterator[StreamEvent]:
        self.last_reasoning = reasoning
        self.last_tools = tools
        self.last_image_resolver = image_resolver
        self.last_messages = messages
        self.calls.append(list(messages))
        call_index = len(self.calls) - 1
        if self._scripts is not None:
            if call_index >= len(self._scripts):
                raise ProviderError(
                    code="fake_script_exhausted",
                    message="No fake provider script remains for this call",
                )
            script = self._scripts[call_index]
        else:
            script = self._script
        for item in script:
            if isinstance(item, RaiseError):
                raise ProviderError(
                    code=item.code,
                    message=item.message,
                    retryable=item.retryable,
                )
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
