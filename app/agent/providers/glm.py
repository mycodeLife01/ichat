"""GLM provider adapter built on the shared OpenAI-compat base.

BigModel's GLM Chat Completions endpoint speaks the standard protocol with two
private extensions: the ``thinking`` request control (``type`` plus
``clear_thinking``) and plaintext ``reasoning_content`` on streamed deltas and
replayed assistant turns. GLM-5.3-family models force thinking on and only
accept ``low`` / ``high`` / ``max`` efforts, so effort values are forwarded
verbatim and thinking-level validity is a catalog configuration concern.

Image input is *not* a capability here. Only some GLM models accept images, so
the catalog's ``ChatModel.supports_image_input`` decides whether a route may
receive them, and this adapter only supplies the standard ``image_url``
encoding it already inherits.
"""

from typing import Any

from app.agent.provider import ProviderCapabilities, ReasoningConfig
from app.agent.providers.openai_compat import OpenAIChatCompletionsProvider

_CAPABILITIES = ProviderCapabilities(
    supports_tool_history=False,
    supports_reasoning=True,
)


class GLMProvider(OpenAIChatCompletionsProvider):
    # GLM's interleaved thinking requires replaying the assistant
    # ``reasoning_content`` verbatim; ``clear_thinking: false`` keeps the
    # server from stripping it out of the provided history.
    _replay_reasoning_in_history = True

    @property
    def name(self) -> str:
        return "glm"

    @property
    def _display_name(self) -> str:
        return "GLM"

    @property
    def capabilities(self) -> ProviderCapabilities:
        return _CAPABILITIES

    def _stream_request_extras(
        self, *, model: str, reasoning: ReasoningConfig | None
    ) -> dict[str, Any]:
        enabled = reasoning.enabled if reasoning is not None else True
        kwargs: dict[str, Any] = {"extra_body": self._thinking_extra_body(reasoning)}
        if enabled and reasoning is not None:
            kwargs["reasoning_effort"] = reasoning.effort
        return kwargs

    def _generate_request_kwargs(
        self,
        *,
        model: str,
        reasoning: ReasoningConfig | None,
        max_output_tokens: int,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"max_tokens": max_output_tokens, "temperature": 0.3}
        kwargs.update(self._stream_request_extras(model=model, reasoning=reasoning))
        return kwargs

    def _reasoning_from_delta(self, delta: Any) -> str | None:
        reasoning_text = getattr(delta, "reasoning_content", None)
        if isinstance(reasoning_text, str) and reasoning_text:
            return reasoning_text
        return None

    @staticmethod
    def _thinking_extra_body(reasoning: ReasoningConfig | None) -> dict[str, Any]:
        enabled = reasoning.enabled if reasoning is not None else True
        return {
            "thinking": {
                "type": "enabled" if enabled else "disabled",
                "clear_thinking": False,
            }
        }
