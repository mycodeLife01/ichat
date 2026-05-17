import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass

from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    TextDelta,
)


@dataclass(frozen=True)
class RaiseError:
    code: str
    message: str


@dataclass(frozen=True)
class Sleep:
    seconds: float


ScriptItem = TextDelta | Finish | RaiseError | Sleep


class FakeProvider(Provider):
    def __init__(self, *, script: Sequence[ScriptItem], name: str = "fake") -> None:
        self._script = list(script)
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]:
        for item in self._script:
            if isinstance(item, RaiseError):
                raise ProviderError(code=item.code, message=item.message)
            if isinstance(item, Sleep):
                await asyncio.sleep(item.seconds)
                continue
            yield item
