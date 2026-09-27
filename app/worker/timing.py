"""Run timing — partition a Run's worker execution into non-overlapping phases.

The worker feeds every AgentEvent (plus the execution milestones around the
agent stream) into a ``RunTimer``. Each instant between the execution start and
the terminal write belongs to exactly one phase, so the phase durations always
sum to ``execution_ms``. Deltas never reach PostgreSQL, so this in-memory record
is the only place reasoning/answering time can be measured.

Durations are derived from integer millisecond marks relative to the start, not
from rounded per-phase floats, which keeps the sum exact without remainder
bookkeeping. Design: ``docs/specs/2026-09-27-run-timing.md``.
"""

import time
from collections.abc import Callable
from typing import Any, Literal

from app.agent import (
    MessageDone,
    ReasoningDelta,
    TextDelta,
    ToolCallFinished,
    ToolCallStarted,
)
from app.agent.events import AgentEvent

TIMING_VERSION = 1

Phase = Literal["preparing", "model_wait", "reasoning", "tool", "answering", "finalizing"]
PHASES: tuple[Phase, ...] = (
    "preparing",
    "model_wait",
    "reasoning",
    "tool",
    "answering",
    "finalizing",
)


class RunTimer:
    def __init__(
        self,
        *,
        queued_ms: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self._start = clock()
        self._queued_ms = queued_ms
        self._phase: Phase = "preparing"
        self._phase_mark = 0
        self._durations: dict[Phase, int] = dict.fromkeys(PHASES, 0)
        self._model_calls = 0
        self._attempts = 0
        self._ttft_ms: int | None = None
        # First text mark of each model call, by call index; the final answer is
        # the last call's text, so work time is only known once the stream ends.
        self._first_text_ms: dict[int, int] = {}
        self._tools: list[dict[str, Any]] = []
        self._result: dict[str, Any] | None = None

    @property
    def result(self) -> dict[str, Any] | None:
        return self._result

    def _now_ms(self) -> int:
        return round((self._clock() - self._start) * 1000)

    def _switch(self, phase: Phase) -> int:
        now = self._now_ms()
        if phase != self._phase:
            self._durations[self._phase] += now - self._phase_mark
            self._phase = phase
            self._phase_mark = now
        return now

    def stream_started(self) -> None:
        """An agent stream attempt begins; its first model call starts now.

        A retry restarts the whole stream before anything was forwarded, so the
        failed attempt stays inside ``model_wait`` and only counts as an attempt.
        """
        self._switch("model_wait")
        self._attempts += 1
        if self._attempts == 1:
            self._model_calls = 1

    def observe(self, event: AgentEvent) -> None:
        if isinstance(event, TextDelta | ReasoningDelta):
            now = self._switch("answering" if isinstance(event, TextDelta) else "reasoning")
            if self._ttft_ms is None:
                self._ttft_ms = now
            if isinstance(event, TextDelta):
                self._first_text_ms.setdefault(self._model_calls, now)
        elif isinstance(event, ToolCallStarted):
            self._switch("tool")
        elif isinstance(event, ToolCallFinished):
            # A turn's calls run concurrently and all Finished events arrive
            # together after the batch, so the first one closes the tool phase
            # (its wall time) and each call's own latency comes from the event.
            self._switch("model_wait")
            self._tools.append(
                {
                    "name": event.tool_name,
                    "ms": event.elapsed_ms if event.elapsed_ms is not None else 0,
                    "ok": not event.is_error,
                }
            )
        elif isinstance(event, MessageDone) and event.message.role == "user":
            # Tool results are appended as a user turn; the next model call
            # starts right after it.
            self._switch("model_wait")
            self._model_calls += 1

    def stream_ended(self) -> None:
        self._switch("finalizing")

    def finish(self, *, outcome: str) -> dict[str, Any]:
        """Close the current phase and return the persisted timing record."""
        execution_ms = self._switch(self._phase)
        self._durations[self._phase] += execution_ms - self._phase_mark
        self._phase_mark = execution_ms
        work_ms = self._first_text_ms.get(self._model_calls) if self._model_calls > 0 else None
        self._result = {
            "version": TIMING_VERSION,
            "outcome": outcome,
            "queued_ms": self._queued_ms,
            "execution_ms": execution_ms,
            "work_ms": work_ms,
            "ttft_ms": self._ttft_ms,
            "phases": dict(self._durations),
            "model_calls": self._model_calls,
            "attempts": self._attempts,
            "tools": list(self._tools),
        }
        return self._result
