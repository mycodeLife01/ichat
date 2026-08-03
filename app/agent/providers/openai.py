"""OpenAI provider adapter built on the shared OpenAI-compat base.

OpenAI's own quirks relative to the shared Chat Completions protocol: reasoning
models take a typed top-level ``reasoning_effort``, the sync path must use
``max_completion_tokens`` (``max_tokens`` is rejected by reasoning models) and
must not pin ``temperature`` (reasoning models only accept the default), and
tool history replays fine without tools registered
(``supports_tool_history=True``).

Reasoning text on responses depends on the upstream: OpenAI's own API never
returns it through Chat Completions, but OpenAI-compatible aggregators do —
OpenRouter streams it in ``delta.reasoning``, DeepSeek-style gateways in
``delta.reasoning_content``. The adapter reads both, so thinking panels light
up whenever the upstream provides the text.
"""

import math
from typing import Any

from app.agent.provider import ProviderCapabilities, ReasoningConfig
from app.agent.providers.openai_compat import OpenAIChatCompletionsProvider

_CAPABILITIES = ProviderCapabilities(
    supports_tool_history=True,
    supports_reasoning=True,
    supports_image_input=True,
)

# Model families that accept the `reasoning_effort` request parameter.
_GPT5_PREFIX = "gpt-5"
_O_SERIES_PREFIXES = ("o1", "o3", "o4")

# Effort values we forward verbatim. OpenRouter accepts the full scale and
# clamps per model (gpt-5.6 natively supports max/xhigh/.../none); anything
# unknown falls back to the universally safe "medium".
_KNOWN_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})


def _base_model(model: str) -> str:
    """Normalize an aggregator model id to the bare OpenAI model name.

    OpenRouter-style ids carry a vendor prefix and an optional variant suffix
    (``openai/gpt-5.6-luna``, ``openai/gpt-5:free``); family detection wants
    just ``gpt-5.6-luna``.
    """
    name = model.rsplit("/", 1)[-1]
    return name.split(":", 1)[0]


def supports_reasoning_control(model: str) -> bool:
    """Whether ``model`` accepts the ``reasoning_effort`` parameter."""
    base = _base_model(model)
    return base.startswith(_GPT5_PREFIX) or base.startswith(_O_SERIES_PREFIXES)


class OpenAIProvider(OpenAIChatCompletionsProvider):
    @property
    def name(self) -> str:
        return "openai"

    @property
    def _display_name(self) -> str:
        return "OpenAI"

    @property
    def capabilities(self) -> ProviderCapabilities:
        return _CAPABILITIES

    def count_tokens(self, text: str) -> int:
        # Conservative estimate: ~0.25 tokens per Latin character (~4 chars per
        # token), ~0.6 per CJK character.
        cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
        return math.ceil(cjk * 0.6 + (len(text) - cjk) * 0.25)

    def _stream_request_extras(
        self, *, model: str, reasoning: ReasoningConfig | None
    ) -> dict[str, Any]:
        return _reasoning_kwargs(model, reasoning)

    def _reasoning_from_delta(self, delta: Any) -> str | None:
        # Neither field is in the typed delta model. `reasoning` is OpenRouter's
        # normalized field; `reasoning_content` covers DeepSeek-style gateways.
        for attribute in ("reasoning", "reasoning_content"):
            text = getattr(delta, attribute, None)
            if isinstance(text, str) and text:
                return text
        return None

    def _generate_request_kwargs(
        self,
        *,
        model: str,
        reasoning: ReasoningConfig | None,
        max_output_tokens: int,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"max_completion_tokens": max_output_tokens}
        kwargs.update(_reasoning_kwargs(model, reasoning))
        return kwargs


def _reasoning_kwargs(model: str, reasoning: ReasoningConfig | None) -> dict[str, Any]:
    if reasoning is None or not supports_reasoning_control(model):
        return {}
    if not reasoning.enabled:
        # "none" is the thinking-off level on gpt-5.6+; aggregators clamp it to
        # the nearest supported level (e.g. minimal) on older reasoning models.
        return {"reasoning_effort": "none"}
    effort = reasoning.effort if reasoning.effort in _KNOWN_EFFORTS else "medium"
    return {"reasoning_effort": effort}
