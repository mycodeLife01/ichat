"""DeepSeek provider adapter built on the shared OpenAI-compat base.

This is the single place DeepSeek's quirks live: non-standard request fields
(``thinking`` / ``reasoning_effort`` ride in ``extra_body``), the
``reasoning_content`` extension on response deltas and replayed history, the
inability to replay tool history without tools registered (declared as a
``ProviderCapabilities`` flag), and DeepSeek's token ratios. Everything
protocol-standard lives in ``openai_compat``.
"""

import math
from collections.abc import Mapping
from typing import Any

from openai import AsyncOpenAI, OpenAI

from app.agent.messages import (
    ContentBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from app.agent.provider import ProviderCapabilities, ReasoningConfig
from app.agent.providers.openai_compat import (
    OpenAIChatCompletionsProvider,
    decode_arguments,
)

_CAPABILITIES = ProviderCapabilities(
    supports_tool_history=False,
    supports_reasoning=True,
    supports_image_input=False,
)


class DeepSeekProvider(OpenAIChatCompletionsProvider):
    # DeepSeek accepts reasoning_content on replayed assistant turns.
    _replay_reasoning_in_history = True

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        default_thinking_enabled: bool,
        default_reasoning_effort: str,
        async_client: AsyncOpenAI | None = None,
        sync_client: OpenAI | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            async_client=async_client,
            sync_client=sync_client,
        )
        self._default_thinking_enabled = default_thinking_enabled
        self._default_reasoning_effort = default_reasoning_effort

    @property
    def name(self) -> str:
        return "deepseek"

    @property
    def _display_name(self) -> str:
        return "DeepSeek"

    @property
    def capabilities(self) -> ProviderCapabilities:
        return _CAPABILITIES

    def count_tokens(self, text: str) -> int:
        # Official DeepSeek guidance: ~0.3 tokens per English character,
        # ~0.6 tokens per Chinese character.
        cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
        return math.ceil(cjk * 0.6 + (len(text) - cjk) * 0.3)

    def _stream_request_extras(
        self, *, model: str, reasoning: ReasoningConfig | None
    ) -> dict[str, Any]:
        if reasoning is None:
            reasoning = ReasoningConfig(
                enabled=self._default_thinking_enabled,
                effort=self._default_reasoning_effort,
            )
        # DeepSeek-specific request fields have no place in the typed openai
        # params, so they ride in extra_body: `thinking` gates reasoning, and
        # `reasoning_effort` tunes it (only meaningful when enabled).
        return {"extra_body": self._thinking_extra_body(reasoning)}

    def _generate_request_kwargs(
        self,
        *,
        model: str,
        reasoning: ReasoningConfig | None,
        max_output_tokens: int,
    ) -> dict[str, Any]:
        enabled = reasoning.enabled if reasoning is not None else False
        effort = reasoning.effort if reasoning is not None else self._default_reasoning_effort
        return {
            "max_tokens": max_output_tokens,
            "temperature": 0.3,
            "extra_body": self._thinking_extra_body(
                ReasoningConfig(enabled=enabled, effort=effort)
            ),
        }

    def _reasoning_from_delta(self, delta: Any) -> str | None:
        # `reasoning_content` is a DeepSeek extension absent from the typed
        # delta model; reach it via untyped attribute access.
        reasoning_text = getattr(delta, "reasoning_content", None)
        if isinstance(reasoning_text, str) and reasoning_text:
            return reasoning_text
        return None

    @staticmethod
    def _thinking_extra_body(reasoning: ReasoningConfig) -> dict[str, Any]:
        extra_body: dict[str, Any] = {
            "thinking": {"type": "enabled" if reasoning.enabled else "disabled"}
        }
        if reasoning.enabled:
            extra_body["reasoning_effort"] = reasoning.effort
        return extra_body


def message_from_wire(wire: Mapping[str, Any]) -> Message:
    """Convert one legacy DeepSeek/OpenAI wire message to neutral blocks.

    This is intentionally owned by the adapter: persisted rows created before the
    blocks migration contain DeepSeek's wire fields, and the transcript service
    must not learn how to interpret them.
    """
    role = wire.get("role")
    content = wire.get("content")
    if role == "tool":
        return Message(
            role="user",
            blocks=[
                ToolResultBlock(
                    tool_call_id=str(wire.get("tool_call_id") or ""),
                    content=content if isinstance(content, str) else "",
                )
            ],
        )
    if role == "assistant":
        blocks: list[ContentBlock] = []
        reasoning = wire.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning:
            blocks.append(ReasoningBlock(text=reasoning))
        if isinstance(content, str) and content:
            blocks.append(TextBlock(text=content))
        tool_calls = wire.get("tool_calls")
        if isinstance(tool_calls, list):
            for item in tool_calls:
                if not isinstance(item, Mapping):
                    continue
                function = item.get("function")
                if not isinstance(function, Mapping):
                    continue
                blocks.append(
                    ToolCallBlock(
                        id=str(item.get("id") or ""),
                        name=str(function.get("name") or ""),
                        arguments=decode_arguments(function.get("arguments")),
                    )
                )
        return Message(role="assistant", blocks=blocks)
    if role == "user":
        return Message(
            role="user",
            blocks=[TextBlock(text=content if isinstance(content, str) else "")],
        )
    if role == "system":
        return Message(
            role="system",
            blocks=[TextBlock(text=content if isinstance(content, str) else "")],
        )
    raise ValueError(f"Unsupported DeepSeek message role: {role!r}")
