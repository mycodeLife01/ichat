from app.agent import (
    Message,
    MessageDone,
    ReasoningDelta,
    TextBlock,
    TextDelta,
    ToolCallFinished,
    ToolCallStarted,
)
from app.worker.timing import PHASES, RunTimer


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, ms: int) -> None:
        self.now += ms / 1000


def _assistant() -> MessageDone:
    return MessageDone(Message(role="assistant", blocks=[TextBlock(text="x")]))


def _tool_results() -> MessageDone:
    return MessageDone(Message(role="user", blocks=[]))


def _assert_partition(timing: dict[str, object]) -> None:
    phases = timing["phases"]
    assert isinstance(phases, dict)
    assert set(phases) == set(PHASES)
    assert sum(phases.values()) == timing["execution_ms"]


def test_reasoning_then_answer_partitions_execution() -> None:
    clock = FakeClock()
    timer = RunTimer(queued_ms=7, clock=clock)
    clock.advance(50)
    timer.stream_started()
    clock.advance(300)
    timer.observe(ReasoningDelta(text="a"))
    clock.advance(2000)
    timer.observe(ReasoningDelta(text="b"))
    clock.advance(1000)
    timer.observe(TextDelta(text="c"))
    clock.advance(500)
    timer.observe(_assistant())
    timer.stream_ended()
    clock.advance(40)

    timing = timer.finish(outcome="succeeded")

    assert timing == {
        "version": 1,
        "outcome": "succeeded",
        "queued_ms": 7,
        "execution_ms": 3890,
        "work_ms": 3350,
        "ttft_ms": 350,
        "phases": {
            "preparing": 50,
            "model_wait": 300,
            "reasoning": 3000,
            "tool": 0,
            "answering": 500,
            "finalizing": 40,
        },
        "model_calls": 1,
        "attempts": 1,
        "tools": [],
    }


def test_work_time_ends_at_the_last_model_calls_first_text() -> None:
    clock = FakeClock()
    timer = RunTimer(clock=clock)
    timer.stream_started()
    clock.advance(100)
    # Preamble text before a tool call must not end the work time.
    timer.observe(TextDelta(text="Let me search."))
    clock.advance(100)
    timer.observe(_assistant())
    timer.observe(ToolCallStarted(tool_name="web_search", arguments={"query": "q"}))
    clock.advance(1500)
    timer.observe(ToolCallFinished(tool_name="web_search", is_error=False))
    timer.observe(_tool_results())
    clock.advance(400)
    timer.observe(ReasoningDelta(text="r"))
    clock.advance(600)
    timer.observe(TextDelta(text="Answer"))
    clock.advance(200)
    timer.stream_ended()

    timing = timer.finish(outcome="succeeded")

    _assert_partition(timing)
    assert timing["work_ms"] == 2700
    assert timing["ttft_ms"] == 100
    assert timing["model_calls"] == 2
    assert timing["tools"] == [{"name": "web_search", "ms": 1500, "ok": True}]
    assert timing["phases"] == {
        "preparing": 0,
        "model_wait": 500,
        "reasoning": 600,
        "tool": 1500,
        "answering": 300,
        "finalizing": 0,
    }


def test_tool_finished_without_start_counts_zero() -> None:
    clock = FakeClock()
    timer = RunTimer(clock=clock)
    timer.stream_started()
    timer.observe(_assistant())
    clock.advance(10)
    timer.observe(ToolCallFinished(tool_name="unknown", is_error=True))
    timer.stream_ended()

    timing = timer.finish(outcome="failed")

    _assert_partition(timing)
    assert timing["tools"] == [{"name": "unknown", "ms": 0, "ok": False}]


def test_retry_stays_in_model_wait_and_counts_attempts() -> None:
    clock = FakeClock()
    timer = RunTimer(clock=clock)
    timer.stream_started()
    clock.advance(800)
    timer.stream_started()
    clock.advance(200)
    timer.observe(TextDelta(text="ok"))
    timer.stream_ended()

    timing = timer.finish(outcome="succeeded")

    _assert_partition(timing)
    assert timing["attempts"] == 2
    assert timing["model_calls"] == 1
    assert timing["phases"]["model_wait"] == 1000
    assert timing["work_ms"] == 1000


def test_cancel_before_answer_has_no_work_time() -> None:
    clock = FakeClock()
    timer = RunTimer(clock=clock)
    timer.stream_started()
    clock.advance(100)
    timer.observe(ReasoningDelta(text="r"))
    clock.advance(100)
    timer.stream_ended()

    timing = timer.finish(outcome="cancelled")

    _assert_partition(timing)
    assert timing["work_ms"] is None
    assert timing["outcome"] == "cancelled"


def test_build_failure_records_only_preparing() -> None:
    clock = FakeClock()
    timer = RunTimer(clock=clock)
    clock.advance(25)

    timing = timer.finish(outcome="failed")

    _assert_partition(timing)
    assert timing["phases"]["preparing"] == 25
    assert timing["model_calls"] == 0
    assert timing["attempts"] == 0
    assert timing["work_ms"] is None
    assert timing["ttft_ms"] is None


def test_sub_millisecond_steps_still_sum_exactly() -> None:
    clock = FakeClock()
    timer = RunTimer(clock=clock)
    timer.stream_started()
    for _ in range(50):
        clock.now += 0.0004
        timer.observe(ReasoningDelta(text="r"))
        clock.now += 0.0007
        timer.observe(TextDelta(text="t"))
    timer.stream_ended()

    _assert_partition(timer.finish(outcome="succeeded"))
