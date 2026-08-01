"""Provider-neutral message model built from content blocks.

The whole agent kernel speaks this vocabulary; provider wire formats
(DeepSeek/OpenAI, Anthropic, Gemini) are an adapter concern and never leak in
here. The model deliberately sits on the information-richer end (Anthropic-style
content blocks): flattening blocks to a provider's shape is a lossless
projection, while the reverse would not be. See ``tests/agent/test_messages.py``
for the round-trip proofs against all three target APIs.
"""

from dataclasses import dataclass
from typing import Any, Literal

Role = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class TextBlock:
    """User-facing text — a prompt, or an assistant's answer."""

    text: str


@dataclass(frozen=True)
class ReasoningBlock:
    """Model reasoning / thinking content (DeepSeek ``reasoning_content``,
    Anthropic ``thinking``, Gemini thought parts)."""

    text: str


@dataclass(frozen=True)
class ToolCallBlock:
    """A tool invocation requested by the assistant.

    ``arguments`` is the decoded argument object, not a wire string; adapters
    serialize it to whatever their API expects (OpenAI's JSON string, Anthropic's
    ``input`` object, Gemini's ``args`` object).
    """

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolResultBlock:
    """The result of a tool call, carried inside a ``user`` message (Anthropic
    convention). ``is_error`` records whether the tool failed."""

    tool_call_id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class DocumentBlock:
    """Complete, immutable extract of a model-consumable attachment.

    Attachment content remains untrusted user data. Providers receive the full
    ``text`` projection; the identity/hash/version fields make transcripts
    self-describing and independent from object storage or future extractors.
    """

    file_id: str
    filename: str
    media_type: str
    text: str
    sha256: str
    extractor_version: str
    warnings: tuple[str, ...] = ()
    summary: dict[str, Any] | None = None


@dataclass(frozen=True)
class AttachmentNoticeBlock:
    """Minimal notice for a display-only attachment such as an image."""

    file_id: str
    filename: str
    media_type: str
    notice: str = "This attachment is present but cannot be read by the current model."


ContentBlock = (
    TextBlock
    | DocumentBlock
    | AttachmentNoticeBlock
    | ReasoningBlock
    | ToolCallBlock
    | ToolResultBlock
)


@dataclass(frozen=True)
class Message:
    role: Role
    blocks: list[ContentBlock]

    def text(self) -> str:
        """Concatenate the user-facing text blocks (ignores reasoning/tool)."""
        return "".join(b.text for b in self.blocks if isinstance(b, TextBlock))

    def reasoning(self) -> str | None:
        parts = [b.text for b in self.blocks if isinstance(b, ReasoningBlock)]
        return "".join(parts) if parts else None


def user_text(text: str) -> Message:
    return Message(role="user", blocks=[TextBlock(text=text)])


def assistant_text(text: str, *, reasoning: str | None = None) -> Message:
    blocks: list[ContentBlock] = []
    if reasoning:
        blocks.append(ReasoningBlock(text=reasoning))
    blocks.append(TextBlock(text=text))
    return Message(role="assistant", blocks=blocks)


def system_text(text: str) -> Message:
    return Message(role="system", blocks=[TextBlock(text=text)])
