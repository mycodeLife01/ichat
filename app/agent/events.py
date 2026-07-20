from dataclasses import dataclass
from typing import Any, Literal, Protocol

RunEventType = Literal[
    "run_started",
    "text_delta",
    "reasoning_delta",
    "tool_call_started",
    "tool_call_succeeded",
    "tool_call_failed",
    "run_succeeded",
    "run_failed",
    "run_cancelled",
]


@dataclass(frozen=True)
class RunEvent:
    seq: int
    type: RunEventType
    payload: dict[str, Any]


class EventSink(Protocol):
    async def emit(self, event: RunEvent) -> None: ...
