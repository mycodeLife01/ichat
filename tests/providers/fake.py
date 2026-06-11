import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass

from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ReasoningDelta,
    TextDelta,
    ThinkingOptions,
)


@dataclass(frozen=True)
class RaiseError:
    code: str
    message: str


@dataclass(frozen=True)
class Sleep:
    seconds: float


ScriptItem = TextDelta | ReasoningDelta | Finish | RaiseError | Sleep


class FakeProvider(Provider):
    def __init__(
        self,
        *,
        script: Sequence[ScriptItem],
        name: str = "fake",
        summarize_result: str | ProviderError = "Fake Title",
    ) -> None:
        self._script = list(script)
        self._name = name
        self._summarize_result = summarize_result
        self.last_thinking: ThinkingOptions | None = None

    @property
    def name(self) -> str:
        return self._name

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        thinking: ThinkingOptions | None = None,
    ) -> AsyncIterator[ProviderChunk]:
        self.last_thinking = thinking
        for item in self._script:
            if isinstance(item, RaiseError):
                raise ProviderError(code=item.code, message=item.message)
            if isinstance(item, Sleep):
                await asyncio.sleep(item.seconds)
                continue
            yield item

    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        if isinstance(self._summarize_result, ProviderError):
            raise self._summarize_result
        return self._summarize_result
