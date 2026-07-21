"""Provider protocol, streaming events, and capabilities for the agent kernel.

A provider adapter is the *only* place a wire format lives. The kernel talks to
it through neutral ``Message`` blocks in and ``StreamEvent`` out; per-provider
quirks are declared as ``ProviderCapabilities`` so the orchestration layer
decides by capability, never by provider name.
"""

import math
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from app.agent.messages import Message
from app.agent.tools.base import ToolSpec


@dataclass(frozen=True)
class ProviderCapabilities:
    """Declared provider quirks the orchestration layer branches on."""

    supports_tool_history: bool
    supports_reasoning: bool


@dataclass(frozen=True)
class ReasoningConfig:
    """Per-request reasoning/thinking control (replaces ThinkingOptions)."""

    enabled: bool
    effort: str


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ReasoningDelta:
    text: str


@dataclass(frozen=True)
class ToolCallDone:
    """A fully-assembled tool call. Adapters buffer streamed argument fragments
    and emit one of these per call once complete, so the kernel never sees
    partial tool arguments."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class StreamDone:
    """Terminal event of a provider turn."""

    finish_reason: str
    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None


StreamEvent = TextDelta | ReasoningDelta | ToolCallDone | StreamDone


class ProviderError(Exception):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Provider(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @property
    @abstractmethod
    def capabilities(self) -> ProviderCapabilities: ...

    def count_tokens(self, text: str) -> int:
        """Estimate the token count of ``text`` for context budgeting.

        Deliberately conservative (over-estimates) so trimming errs on the safe
        side; providers should override with model-specific rules.
        """
        cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
        return math.ceil(cjk * 1.0 + (len(text) - cjk) * 0.5)

    @abstractmethod
    def stream(
        self,
        *,
        model: str,
        messages: list[Message],
        reasoning: ReasoningConfig | None = None,
        tools: list[ToolSpec] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Stream one provider turn as neutral events."""
        ...

    @abstractmethod
    def generate(
        self,
        *,
        model: str,
        messages: list[Message],
        max_output_tokens: int,
        reasoning: ReasoningConfig | None = None,
    ) -> str:
        """Synchronous, non-streaming completion.

        The sync path serves fire-and-forget Celery tasks (e.g. title
        generation) that want a mature client's retry/timeout handling without an
        event loop. Returns the assistant text.
        """
        ...
