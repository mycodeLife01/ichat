"""AgentEvent vocabulary — the kernel's neutral event language.

The orchestration layer's ``ChatAgent.stream()`` yields these; the worker
consumes them and engineers them into run events, seq numbers, and DB writes.
The vocabulary is deliberately platform-agnostic: no run id, no seq, no sink, no
cancellation. ``succeeded`` / ``failed`` are *not* encoded here — the worker
maps ``ToolCallFinished.is_error`` and the terminal ``AgentFinal`` to run status.

``TextDelta`` and ``ReasoningDelta`` are reused verbatim from the provider's
``StreamEvent`` union: a delta flowing up from the model call is the same value
the orchestration layer forwards, so there is nothing to translate.
"""

from dataclasses import dataclass, field
from typing import Any

from app.agent.messages import Message
from app.agent.provider import ReasoningDelta, TextDelta


@dataclass(frozen=True)
class ToolCallStarted:
    """A tool is about to execute. Never announced for unknown-tool or
    limit-exceeded calls (those go straight to an error ``ToolCallFinished``)."""

    tool_name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolCallFinished:
    """A tool call resolved. ``is_error`` records whether it maps to a failed
    run event; ``metadata`` carries the tool's free-form product (sources,
    query, error code) for the sink to project onto the external payload."""

    tool_name: str
    is_error: bool
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MessageDone:
    """A message (assistant turn or tool-results user turn) is complete and
    belongs in the transcript. Not a wire event — the worker accumulates it."""

    message: Message


@dataclass(frozen=True)
class AgentFinal:
    """The agent loop finished with a final answer. Carries the usage and
    request id of the last model call (usage accounting unchanged from the
    runner)."""

    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None


AgentEvent = (
    TextDelta | ReasoningDelta | ToolCallStarted | ToolCallFinished | MessageDone | AgentFinal
)

__all__ = [
    "AgentEvent",
    "AgentFinal",
    "MessageDone",
    "ReasoningDelta",
    "TextDelta",
    "ToolCallFinished",
    "ToolCallStarted",
]
