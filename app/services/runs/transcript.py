import json
from collections.abc import Callable, Mapping
from typing import Any, cast

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import (
    AttachmentNoticeBlock,
    ContentBlock,
    DocumentBlock,
    ImageBlock,
    Message,
    ReasoningBlock,
    Role,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from app.agent.providers.deepseek import message_from_wire
from app.models.run import RunProviderMessage


async def append_transcript_message(
    session: AsyncSession,
    *,
    run_id: int,
    message: Message,
    message_id: int | None = None,
    count_tokens: Callable[[str], int] | None = None,
) -> RunProviderMessage:
    if message.role == "system":
        raise ValueError("System messages are not part of a run transcript")
    stored_blocks = serialize_blocks(message.blocks)
    row = RunProviderMessage(
        run_id=run_id,
        seq=await get_next_transcript_seq(session, run_id=run_id),
        message_id=message_id,
        role=message.role,
        blocks=stored_blocks,
        estimated_tokens=_estimate_tokens(stored_blocks, count_tokens=count_tokens),
    )
    session.add(row)
    await session.flush()
    return row


async def backfill_transcript_message_id(
    session: AsyncSession,
    *,
    transcript_row_id: int,
    message_id: int,
) -> None:
    await session.execute(
        update(RunProviderMessage)
        .where(RunProviderMessage.id == transcript_row_id)
        .values(message_id=message_id)
    )


async def get_next_transcript_seq(session: AsyncSession, *, run_id: int) -> int:
    max_seq = await session.scalar(
        select(func.max(RunProviderMessage.seq)).where(RunProviderMessage.run_id == run_id)
    )
    return 1 if max_seq is None else max_seq + 1


async def load_transcript(session: AsyncSession, *, run_id: int) -> list[Message]:
    rows = (
        await session.scalars(
            select(RunProviderMessage)
            .where(RunProviderMessage.run_id == run_id)
            .order_by(RunProviderMessage.seq.asc())
        )
    ).all()
    return [transcript_message_from_row(row) for row in rows]


def serialize_blocks(blocks: list[ContentBlock]) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for block in blocks:
        if isinstance(block, TextBlock):
            serialized.append({"type": "text", "text": block.text})
        elif isinstance(block, DocumentBlock):
            serialized.append(
                {
                    "type": "document",
                    "file_id": block.file_id,
                    "filename": block.filename,
                    "media_type": block.media_type,
                    "text": block.text,
                    "sha256": block.sha256,
                    "extractor_version": block.extractor_version,
                    "warnings": list(block.warnings),
                    "summary": block.summary,
                }
            )
        elif isinstance(block, ImageBlock):
            serialized.append(
                {
                    "type": "image",
                    "file_id": block.file_id,
                    "filename": block.filename,
                    "media_type": block.media_type,
                    "sha256": block.sha256,
                    "width": block.width,
                    "height": block.height,
                    "processor_version": block.processor_version,
                    "warnings": list(block.warnings),
                }
            )
        elif isinstance(block, AttachmentNoticeBlock):
            serialized.append(
                {
                    "type": "attachment_notice",
                    "file_id": block.file_id,
                    "filename": block.filename,
                    "media_type": block.media_type,
                    "notice": block.notice,
                }
            )
        elif isinstance(block, ReasoningBlock):
            serialized.append({"type": "reasoning", "text": block.text})
        elif isinstance(block, ToolCallBlock):
            serialized.append(
                {
                    "type": "tool_call",
                    "id": block.id,
                    "name": block.name,
                    "arguments": block.arguments,
                }
            )
        else:
            serialized.append(
                {
                    "type": "tool_result",
                    "tool_call_id": block.tool_call_id,
                    "content": block.content,
                    "is_error": block.is_error,
                }
            )
    return serialized


def transcript_message_from_row(row: RunProviderMessage) -> Message:
    if row.blocks is not None:
        return Message(role=_blocks_role(row.role), blocks=_deserialize_blocks(row.blocks))
    return message_from_wire(_legacy_wire_from_row(row))


def _deserialize_blocks(raw_blocks: object) -> list[ContentBlock]:
    if not isinstance(raw_blocks, list):
        raise ValueError("Transcript blocks must be a JSON array")
    blocks: list[ContentBlock] = []
    for raw in raw_blocks:
        if not isinstance(raw, Mapping):
            raise ValueError("Transcript block must be a JSON object")
        block_type = raw.get("type")
        if block_type == "text":
            blocks.append(TextBlock(text=_required_string(raw, "text")))
        elif block_type == "document":
            warnings = raw.get("warnings", [])
            if not isinstance(warnings, list) or not all(
                isinstance(item, str) for item in warnings
            ):
                raise ValueError("Transcript document warnings must be a string array")
            summary = raw.get("summary")
            if summary is not None and not isinstance(summary, dict):
                raise ValueError("Transcript document summary must be a JSON object")
            blocks.append(
                DocumentBlock(
                    file_id=_required_string(raw, "file_id"),
                    filename=_required_string(raw, "filename"),
                    media_type=_required_string(raw, "media_type"),
                    text=_required_string(raw, "text"),
                    sha256=_required_string(raw, "sha256"),
                    extractor_version=_required_string(raw, "extractor_version"),
                    warnings=tuple(warnings),
                    summary=summary,
                )
            )
        elif block_type == "attachment_notice":
            blocks.append(
                AttachmentNoticeBlock(
                    file_id=_required_string(raw, "file_id"),
                    filename=_required_string(raw, "filename"),
                    media_type=_required_string(raw, "media_type"),
                    notice=_required_string(raw, "notice"),
                )
            )
        elif block_type == "image":
            _require_exact_fields(
                raw,
                {
                    "type",
                    "file_id",
                    "filename",
                    "media_type",
                    "sha256",
                    "width",
                    "height",
                    "processor_version",
                    "warnings",
                },
            )
            warnings = raw.get("warnings")
            if not isinstance(warnings, list) or not all(
                isinstance(item, str) for item in warnings
            ):
                raise ValueError("Transcript image warnings must be a string array")
            width = _required_positive_int(raw, "width")
            height = _required_positive_int(raw, "height")
            blocks.append(
                ImageBlock(
                    file_id=_required_string(raw, "file_id"),
                    filename=_required_string(raw, "filename"),
                    media_type=_required_string(raw, "media_type"),
                    sha256=_required_string(raw, "sha256"),
                    width=width,
                    height=height,
                    processor_version=_required_string(raw, "processor_version"),
                    warnings=tuple(warnings),
                )
            )
        elif block_type == "reasoning":
            blocks.append(ReasoningBlock(text=_required_string(raw, "text")))
        elif block_type == "tool_call":
            arguments = raw.get("arguments")
            if not isinstance(arguments, dict):
                raise ValueError("Transcript tool_call arguments must be a JSON object")
            blocks.append(
                ToolCallBlock(
                    id=_required_string(raw, "id"),
                    name=_required_string(raw, "name"),
                    arguments=arguments,
                )
            )
        elif block_type == "tool_result":
            is_error = raw.get("is_error", False)
            if not isinstance(is_error, bool):
                raise ValueError("Transcript tool_result is_error must be a boolean")
            blocks.append(
                ToolResultBlock(
                    tool_call_id=_required_string(raw, "tool_call_id"),
                    content=_required_string(raw, "content"),
                    is_error=is_error,
                )
            )
        else:
            raise ValueError(f"Unsupported transcript block type: {block_type!r}")
    return blocks


def _legacy_wire_from_row(row: RunProviderMessage) -> dict[str, Any]:
    wire: dict[str, Any] = {"role": row.role, "content": row.content}
    if row.reasoning_content is not None:
        wire["reasoning_content"] = row.reasoning_content
    if row.tool_call_id is not None:
        wire["tool_call_id"] = row.tool_call_id
    if row.tool_name is not None:
        wire["name"] = row.tool_name
    if row.tool_calls is not None:
        wire["tool_calls"] = row.tool_calls
    return wire


def _blocks_role(role: str) -> Role:
    if role in ("user", "assistant", "system"):
        return cast(Role, role)
    raise ValueError(f"Unsupported blocks transcript role: {role!r}")


def _required_string(raw: Mapping[object, object], field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str):
        raise ValueError(f"Transcript block field {field!r} must be a string")
    return value


def _required_positive_int(raw: Mapping[object, object], field: str) -> int:
    value = raw.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"Transcript image field {field!r} must be a positive integer")
    return value


def _require_exact_fields(raw: Mapping[object, object], expected: set[str]) -> None:
    if set(raw) != expected:
        raise ValueError("Transcript image fields are incomplete or inconsistent")


def _estimate_tokens(
    blocks: list[dict[str, Any]],
    *,
    count_tokens: Callable[[str], int] | None,
) -> int:
    if count_tokens is None:
        return 0
    return count_tokens(json.dumps(blocks, ensure_ascii=False, separators=(",", ":")))
