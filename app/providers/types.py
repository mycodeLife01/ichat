import math
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

ProviderRole = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class ProviderMessage:
    role: ProviderRole
    content: str


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ReasoningDelta:
    text: str


@dataclass(frozen=True)
class Finish:
    finish_reason: str
    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None


ProviderChunk = TextDelta | ReasoningDelta | Finish


class ProviderError(Exception):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Provider(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    def count_tokens(self, text: str) -> int:
        """Estimate the token count of ``text`` for context budgeting.

        Deliberately conservative (over-estimates) so trimming errs on the
        safe side; providers should override with model-specific rules.
        """
        cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
        return math.ceil(cjk * 1.0 + (len(text) - cjk) * 0.5)

    @abstractmethod
    def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]: ...

    @abstractmethod
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        raise NotImplementedError
