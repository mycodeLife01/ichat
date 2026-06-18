import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

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


class RunToolSourceResponse(BaseModel):
    id: int
    title: str
    url: str


class RunToolStateResponse(BaseModel):
    status: Literal["running", "succeeded", "failed"]
    tool_name: str
    query: str | None = None
    message: str | None = None
    result_count: int | None = None
    sources: list[RunToolSourceResponse] = Field(default_factory=list)


class RunStateResponse(BaseModel):
    run_id: uuid.UUID
    status: RunStatus
    latest_seq: int
    draft_text: str
    draft_reasoning: str = ""
    tool_state: RunToolStateResponse | None = None
    terminal_event: RunEventResponse | None = None
