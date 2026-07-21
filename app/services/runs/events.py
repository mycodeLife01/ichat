"""Internal run-event vocabulary — the canonical shape the worker writes to the
``run_events`` table.

``RunEvent`` here is the in-flight value the worker assembles (seq + type +
payload) before persistence, distinct from the ORM row ``app.models.run.RunEvent``.
``RunEventType`` intentionally duplicates ``app.schemas.runs.RunEventType``: the
API contract and this internal vocabulary evolve on different clocks, so they are
kept separate rather than merged.
"""

from dataclasses import dataclass
from typing import Any, Literal

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
