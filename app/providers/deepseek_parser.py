import json
from typing import Any

from app.providers.types import (
    Finish,
    ProviderChunk,
    ProviderError,
    ProviderToolCallDelta,
    ReasoningDelta,
    TextDelta,
    ToolCallDelta,
)


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
    reasoning_content = delta.get("reasoning_content")
    tool_calls = delta.get("tool_calls")

    if finish_reason is not None:
        usage = data.get("usage")
        if not isinstance(usage, dict):
            usage = None
        return Finish(finish_reason=finish_reason, usage=usage, provider_request_id=None)
    if isinstance(tool_calls, list) and tool_calls:
        calls: list[ProviderToolCallDelta] = []
        for raw_call in tool_calls:
            if not isinstance(raw_call, dict):
                continue
            raw_function = raw_call.get("function")
            function = raw_function if isinstance(raw_function, dict) else {}
            index = raw_call.get("index")
            if not isinstance(index, int):
                index = len(calls)
            name = function.get("name")
            arguments = function.get("arguments")
            call_id = raw_call.get("id")
            calls.append(
                ProviderToolCallDelta(
                    index=index,
                    id=call_id if isinstance(call_id, str) else None,
                    name=name if isinstance(name, str) else None,
                    arguments=arguments if isinstance(arguments, str) else None,
                )
            )
        if calls:
            return ToolCallDelta(calls=calls)
    if isinstance(content, str) and content != "":
        return TextDelta(text=content)
    if isinstance(reasoning_content, str) and reasoning_content != "":
        return ReasoningDelta(text=reasoning_content)
    return None
