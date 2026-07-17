"""Round-trip proofs that the neutral block model maps losslessly onto the
message APIs of all three target providers (OpenAI, Anthropic, Gemini).

The claim under test (PRD user story 4) is that the neutral model sits on the
information-richer end: every block projects onto each API, and a provider
adapter can reconstruct the same blocks. Correlation tokens differ per API —
OpenAI/Anthropic key tool results by id, Gemini keys by call order — so the
Gemini mapper below tracks ids positionally the way a real adapter would.
"""

import json

from app.agent.messages import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    assistant_text,
    system_text,
    user_text,
)


def _conversation() -> list[Message]:
    return [
        system_text("You are helpful."),
        user_text("What's the weather in SF?"),
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock(text="I should look this up."),
                ToolCallBlock(id="call_1", name="get_weather", arguments={"city": "SF"}),
            ],
        ),
        Message(
            role="user",
            blocks=[ToolResultBlock(tool_call_id="call_1", content="Sunny, 20C")],
        ),
        assistant_text("It's sunny and 20°C in SF.", reasoning="The tool answered."),
    ]


# --- OpenAI (also DeepSeek's wire shape) -------------------------------------


def _to_openai(messages: list[Message]) -> list[dict]:
    rows: list[dict] = []
    for message in messages:
        if message.role == "system":
            rows.append({"role": "system", "content": message.text()})
        elif message.role == "user":
            tool_results = [b for b in message.blocks if isinstance(b, ToolResultBlock)]
            for block in tool_results:
                rows.append(
                    {"role": "tool", "tool_call_id": block.tool_call_id, "content": block.content}
                )
            texts = [b for b in message.blocks if isinstance(b, TextBlock)]
            if texts or not tool_results:
                rows.append({"role": "user", "content": "".join(b.text for b in texts)})
        else:
            content = "".join(b.text for b in message.blocks if isinstance(b, TextBlock))
            reasoning = "".join(b.text for b in message.blocks if isinstance(b, ReasoningBlock))
            calls = [
                {
                    "id": b.id,
                    "type": "function",
                    "function": {"name": b.name, "arguments": json.dumps(b.arguments)},
                }
                for b in message.blocks
                if isinstance(b, ToolCallBlock)
            ]
            row: dict = {"role": "assistant", "content": content or None}
            if reasoning:
                row["reasoning_content"] = reasoning
            if calls:
                row["tool_calls"] = calls
            rows.append(row)
    return rows


def _from_openai(rows: list[dict]) -> list[Message]:
    messages: list[Message] = []
    for row in rows:
        role = row["role"]
        if role == "system":
            messages.append(Message(role="system", blocks=[TextBlock(row["content"])]))
        elif role == "user":
            messages.append(Message(role="user", blocks=[TextBlock(row["content"])]))
        elif role == "tool":
            messages.append(
                Message(
                    role="user",
                    blocks=[ToolResultBlock(row["tool_call_id"], row["content"])],
                )
            )
        else:
            blocks: list = []
            if row.get("reasoning_content"):
                blocks.append(ReasoningBlock(row["reasoning_content"]))
            if row.get("content"):
                blocks.append(TextBlock(row["content"]))
            for call in row.get("tool_calls", []):
                fn = call["function"]
                blocks.append(ToolCallBlock(call["id"], fn["name"], json.loads(fn["arguments"])))
            messages.append(Message(role="assistant", blocks=blocks))
    return messages


def test_round_trip_openai() -> None:
    conversation = _conversation()
    assert _from_openai(_to_openai(conversation)) == conversation


# --- Anthropic ---------------------------------------------------------------


def _to_anthropic(messages: list[Message]) -> tuple[str, list[dict]]:
    system = ""
    rows: list[dict] = []
    for message in messages:
        if message.role == "system":
            system = message.text()
            continue
        content: list[dict] = []
        for block in message.blocks:
            if isinstance(block, ReasoningBlock):
                content.append({"type": "thinking", "thinking": block.text})
            elif isinstance(block, TextBlock):
                content.append({"type": "text", "text": block.text})
            elif isinstance(block, ToolCallBlock):
                content.append(
                    {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.arguments,
                    }
                )
            elif isinstance(block, ToolResultBlock):
                content.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.tool_call_id,
                        "content": block.content,
                        "is_error": block.is_error,
                    }
                )
        rows.append({"role": message.role, "content": content})
    return system, rows


def _from_anthropic(system: str, rows: list[dict]) -> list[Message]:
    messages: list[Message] = [system_text(system)]
    for row in rows:
        blocks: list = []
        for item in row["content"]:
            kind = item["type"]
            if kind == "thinking":
                blocks.append(ReasoningBlock(item["thinking"]))
            elif kind == "text":
                blocks.append(TextBlock(item["text"]))
            elif kind == "tool_use":
                blocks.append(ToolCallBlock(item["id"], item["name"], item["input"]))
            elif kind == "tool_result":
                blocks.append(
                    ToolResultBlock(item["tool_use_id"], item["content"], item["is_error"])
                )
        messages.append(Message(role=row["role"], blocks=blocks))
    return messages


def test_round_trip_anthropic() -> None:
    conversation = _conversation()
    system, rows = _to_anthropic(conversation)
    assert _from_anthropic(system, rows) == conversation


def test_anthropic_preserves_tool_error_flag() -> None:
    conversation = [
        Message(
            role="user",
            blocks=[ToolResultBlock("call_9", "boom", is_error=True)],
        )
    ]
    system, rows = _to_anthropic(conversation)
    restored = _from_anthropic(system, rows)[1:]  # drop the synthesized system
    assert restored == conversation


# --- Gemini ------------------------------------------------------------------


class _GeminiMapper:
    """Gemini correlates function calls/responses by order, not id; a real
    adapter tracks the ids it emitted. This mirrors that."""

    def __init__(self) -> None:
        self._call_ids: list[str] = []

    def to_gemini(self, messages: list[Message]) -> tuple[str, list[dict]]:
        system = ""
        rows: list[dict] = []
        for message in messages:
            if message.role == "system":
                system = message.text()
                continue
            role = "model" if message.role == "assistant" else "user"
            parts: list[dict] = []
            for block in message.blocks:
                if isinstance(block, ReasoningBlock):
                    parts.append({"text": block.text, "thought": True})
                elif isinstance(block, TextBlock):
                    parts.append({"text": block.text})
                elif isinstance(block, ToolCallBlock):
                    self._call_ids.append(block.id)
                    parts.append({"functionCall": {"name": block.name, "args": block.arguments}})
                elif isinstance(block, ToolResultBlock):
                    parts.append(
                        {"functionResponse": {"response": {"content": block.content}}}
                    )
            rows.append({"role": role, "parts": parts})
        return system, rows

    def from_gemini(self, system: str, rows: list[dict]) -> list[Message]:
        messages: list[Message] = [system_text(system)]
        call_ids = iter(self._call_ids)
        pending: list[str] = []
        for row in rows:
            role = "assistant" if row["role"] == "model" else "user"
            blocks: list = []
            for part in row["parts"]:
                if "functionCall" in part:
                    fc = part["functionCall"]
                    call_id = next(call_ids)
                    pending.append(call_id)
                    blocks.append(ToolCallBlock(call_id, fc["name"], fc["args"]))
                elif "functionResponse" in part:
                    fr = part["functionResponse"]
                    blocks.append(ToolResultBlock(pending.pop(0), fr["response"]["content"]))
                elif part.get("thought"):
                    blocks.append(ReasoningBlock(part["text"]))
                else:
                    blocks.append(TextBlock(part["text"]))
            messages.append(Message(role=role, blocks=blocks))
        return messages


def test_round_trip_gemini() -> None:
    conversation = _conversation()
    mapper = _GeminiMapper()
    system, rows = mapper.to_gemini(conversation)
    assert mapper.from_gemini(system, rows) == conversation


def test_message_helpers() -> None:
    assert user_text("hi") == Message(role="user", blocks=[TextBlock("hi")])
    assistant = assistant_text("answer", reasoning="think")
    assert assistant.text() == "answer"
    assert assistant.reasoning() == "think"
    assert user_text("hi").reasoning() is None
