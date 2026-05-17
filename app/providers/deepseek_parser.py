import json
from typing import Any

from app.providers.types import Finish, ProviderChunk, ProviderError, TextDelta


def parse_sse_line(line: str) -> ProviderChunk | None:
    stripped = line.strip()
    if not stripped.startswith("data:"):
        return None
    payload = stripped[len("data:"):].strip()
    if payload == "[DONE]" or payload == "":
        return None
    try:
        data: Any = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ProviderError(
            code="deepseek_invalid_json",
            message=f"Invalid JSON payload: {exc.msg}",
        ) from exc

    choices = data.get("choices") or []
    if not choices:
        return None
    first = choices[0]
    finish_reason = first.get("finish_reason")
    delta = first.get("delta") or {}
    content = delta.get("content")

    if finish_reason is not None:
        usage = data.get("usage")
        if not isinstance(usage, dict):
            usage = None
        return Finish(finish_reason=finish_reason, usage=usage, provider_request_id=None)
    if isinstance(content, str) and content != "":
        return TextDelta(text=content)
    return None
