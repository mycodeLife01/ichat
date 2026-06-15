from dataclasses import dataclass
from typing import Any, Literal

ToolResultStatus = Literal["succeeded", "failed"]


@dataclass(frozen=True)
class ToolResult:
    status: ToolResultStatus
    content: str
    payload: dict[str, Any]
    sources: list[dict[str, object]]
    error_code: str | None = None
    message: str | None = None
