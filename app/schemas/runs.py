from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

RunEventType = Literal[
    "run_started",
    "text_delta",
    "run_succeeded",
    "run_failed",
    "run_cancelled",
]

RunStatus = Literal[
    "queued",
    "started",
    "streaming",
    "succeeded",
    "failed",
    "cancelling",
    "cancelled",
]


class RunEventResponse(BaseModel):
    seq: int
    type: RunEventType
    payload: dict[str, Any]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RunStateResponse(BaseModel):
    run_id: int
    status: RunStatus
    latest_seq: int
    draft_text: str
    terminal_event: RunEventResponse | None
