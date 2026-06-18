from datetime import UTC, datetime
from uuid import uuid4

from app.schemas.runs import RunEventResponse, RunStateResponse


def test_run_event_response_serializes_event_data() -> None:
    event = RunEventResponse(
        seq=2,
        type="text_delta",
        payload={"text": "Hello"},
        created_at=datetime(2026, 5, 17, 12, 0, tzinfo=UTC),
    )

    assert event.seq == 2
    assert event.type == "text_delta"
    assert event.payload == {"text": "Hello"}
    assert '"seq":2' in event.model_dump_json()
    assert '"type":"text_delta"' in event.model_dump_json()


def test_run_state_response_contains_draft_and_terminal_event() -> None:
    terminal = RunEventResponse(
        seq=4,
        type="run_succeeded",
        payload={},
        created_at=datetime(2026, 5, 17, 12, 1, tzinfo=UTC),
    )

    run_id = uuid4()
    state = RunStateResponse(
        run_id=run_id,
        status="succeeded",
        latest_seq=4,
        draft_text="Hello world",
        terminal_event=terminal,
    )

    assert state.run_id == run_id
    assert state.status == "succeeded"
    assert state.latest_seq == 4
    assert state.draft_text == "Hello world"
    assert state.terminal_event == terminal
