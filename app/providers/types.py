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
class Finish:
    finish_reason: str
    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None


ProviderChunk = TextDelta | Finish


class ProviderError(Exception):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Provider(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]: ...
