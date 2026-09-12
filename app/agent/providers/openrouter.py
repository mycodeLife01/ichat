"""OpenRouter adapter for its normalized Chat Completions contract.

OpenRouter is not treated as an interchangeable OpenAI base URL. Its unified
reasoning control lives in ``extra_body.reasoning`` and streamed reasoning may
arrive as either ``reasoning`` or the compatible ``reasoning_content`` alias.
Plaintext reasoning is classified by the selected route contract. Structured
``reasoning_details`` is retained as opaque continuation state and replayed
unchanged for tool-call continuation.
"""

import hashlib
import math
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from openai import APIStatusError, AsyncOpenAI, OpenAI

from app.agent.messages import (
    Message,
    ProviderContinuationBlock,
    ReasoningBlock,
    ReasoningKind,
)
from app.agent.provider import (
    ProviderCapabilities,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
)
from app.agent.providers.openai_compat import OpenAIChatCompletionsProvider

_CAPABILITIES = ProviderCapabilities(
    supports_tool_history=True,
    supports_reasoning=True,
)
_KNOWN_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
_SUMMARY_TEXT_FORMATS = frozenset({"google-gemini-v1"})


class OpenRouterProvider(OpenAIChatCompletionsProvider):
    # Continuation replay is owned by `_assistant_message_extras`; the shared
    # DeepSeek-style `reasoning_content` projection must stay disabled.
    _replay_reasoning_in_history = False

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        token_profile: str = "default",
        reasoning_outputs: Sequence[ReasoningKind] = ("raw",),
        async_client: AsyncOpenAI | None = None,
        sync_client: OpenAI | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            async_client=async_client,
            sync_client=sync_client,
        )
        self._token_profile = token_profile
        self._reasoning_outputs = frozenset(reasoning_outputs)

    @property
    def name(self) -> str:
        return "openrouter"

    @property
    def _display_name(self) -> str:
        return "OpenRouter"

    @property
    def capabilities(self) -> ProviderCapabilities:
        return _CAPABILITIES

    def count_tokens(self, text: str) -> int:
        cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
        if self._token_profile == "deepseek":
            return math.ceil(cjk * 0.6 + (len(text) - cjk) * 0.3)
        if self._token_profile == "openai":
            return math.ceil(cjk * 0.6 + (len(text) - cjk) * 0.25)
        return super().count_tokens(text)

    def _stream_request_extras(
        self, *, model: str, reasoning: ReasoningConfig | None
    ) -> dict[str, Any]:
        return _reasoning_extra(reasoning)

    def _generate_request_kwargs(
        self,
        *,
        model: str,
        reasoning: ReasoningConfig | None,
        max_output_tokens: int,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"max_tokens": max_output_tokens}
        kwargs.update(_reasoning_extra(reasoning))
        return kwargs

    def _reasoning_events_from_delta(
        self, delta: Any, *, model: str
    ) -> list[ReasoningDelta | ProviderContinuationBlock]:
        details = _reasoning_details(delta)
        events: list[ReasoningDelta | ProviderContinuationBlock] = []
        visible_detail = False
        if details:
            events.append(
                ProviderContinuationBlock(
                    owner="openrouter",
                    codec="reasoning_details.v2",
                    scope="assistant_message",
                    payload={
                        "reasoning_details": details,
                        "replay_key": _continuation_replay_key(
                            base_url=self._base_url,
                            model=model,
                        ),
                    },
                )
            )
            for detail in details:
                visible = _visible_reasoning_detail(detail)
                if visible is None:
                    continue
                text, kind = visible
                if isinstance(text, str) and text:
                    visible_detail = True
                    events.append(ReasoningDelta(text=text, kind=kind))

        if visible_detail:
            return events

        plaintext = _plaintext_reasoning(delta)
        if plaintext:
            kind = (
                "summary"
                if self._reasoning_outputs == frozenset({"summary"})
                else "raw"
            )
            if kind in self._reasoning_outputs:
                events.append(ReasoningDelta(text=plaintext, kind=kind))
        return events

    def _assistant_message_extras(
        self, message: Message, *, model: str
    ) -> Mapping[str, Any]:
        details: list[dict[str, Any]] = []
        replay_key = _continuation_replay_key(
            base_url=self._base_url,
            model=model,
        )
        for block in message.blocks:
            if not isinstance(block, ProviderContinuationBlock):
                continue
            if (
                block.owner != "openrouter"
                or block.scope != "assistant_message"
            ):
                continue
            if block.codec == "reasoning_details.v2":
                if block.payload.get("replay_key") != replay_key:
                    continue
            elif block.codec != "reasoning_details.v1":
                continue
            raw_details = block.payload.get("reasoning_details")
            if isinstance(raw_details, list) and all(
                isinstance(item, dict) for item in raw_details
            ):
                details.extend(raw_details)
        if details:
            return {"reasoning_details": details}

        reasoning = "".join(
            block.text
            for block in message.blocks
            if isinstance(block, ReasoningBlock)
        )
        return {"reasoning": reasoning} if reasoning else {}

    def _provider_error_from_status(
        self,
        exc: APIStatusError,
        *,
        contains_image_input: bool,
        summarize: bool = False,
    ) -> ProviderError:
        if not summarize and _is_continuation_incompatible_error(exc):
            return ProviderError(
                code="openrouter_continuation_incompatible",
                message=(
                    "OpenRouter continuation state is incompatible with the selected model"
                ),
            )
        return super()._provider_error_from_status(
            exc,
            contains_image_input=contains_image_input,
            summarize=summarize,
        )


def _plaintext_reasoning(delta: Any) -> str | None:
    for attribute in ("reasoning", "reasoning_content"):
        text = getattr(delta, attribute, None)
        if isinstance(text, str) and text:
            return text
    return None


def _visible_reasoning_detail(
    detail: Mapping[str, Any],
) -> tuple[str, ReasoningKind] | None:
    detail_type = detail.get("type")
    if detail_type == "reasoning.summary":
        text = detail.get("summary")
        return (text, "summary") if isinstance(text, str) else None
    if detail_type != "reasoning.text":
        return None

    text = detail.get("text")
    if not isinstance(text, str):
        return None
    # Gemini exposes summaries of its private thoughts, but OpenRouter encodes
    # those visible summaries as reasoning.text. The nested format is therefore
    # the authoritative semantic discriminator; Markdown shape is not.
    kind: ReasoningKind = (
        "summary" if detail.get("format") in _SUMMARY_TEXT_FORMATS else "raw"
    )
    return text, kind


def _reasoning_details(delta: Any) -> list[dict[str, Any]]:
    raw = getattr(delta, "reasoning_details", None)
    if raw is None:
        model_extra = getattr(delta, "model_extra", None)
        if isinstance(model_extra, Mapping):
            raw = model_extra.get("reasoning_details")
    if raw is None:
        return []
    if not isinstance(raw, Sequence) or isinstance(raw, str | bytes):
        raise ProviderError(
            code="openrouter_invalid_reasoning_details",
            message="OpenRouter returned invalid reasoning details",
        )
    details: list[dict[str, Any]] = []
    try:
        for item in raw:
            converted = _json_value(item)
            if not isinstance(converted, dict):
                raise TypeError
            details.append(converted)
    except (TypeError, ValueError):
        raise ProviderError(
            code="openrouter_invalid_reasoning_details",
            message="OpenRouter returned invalid reasoning details",
        ) from None
    return details


def _json_value(value: Any) -> Any:
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _json_value(model_dump(mode="json"))
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return [_json_value(item) for item in value]
    raise TypeError


def _reasoning_extra(reasoning: ReasoningConfig | None) -> dict[str, Any]:
    if reasoning is None:
        return {}
    effort = "none" if not reasoning.enabled else reasoning.effort
    if effort not in _KNOWN_EFFORTS:
        effort = "medium"
    return {"extra_body": {"reasoning": {"effort": effort}}}


def _continuation_replay_key(*, base_url: str, model: str) -> str:
    material = f"{_normalized_base_url(base_url)}\n{model}".encode()
    digest = hashlib.sha256(material).hexdigest()
    return f"openrouter:v1:{digest}"


def _normalized_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 80 if scheme == "http" else 443
    port = parsed.port
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    return urlunsplit((scheme, netloc, parsed.path.rstrip("/"), "", ""))


def _is_continuation_incompatible_error(exc: APIStatusError) -> bool:
    candidates: list[str] = []
    body = getattr(exc, "body", None)
    if isinstance(body, Mapping):
        error = body.get("error")
        if isinstance(error, Mapping):
            message = error.get("message")
            if isinstance(message, str):
                candidates.append(message)
        message = body.get("message")
        if isinstance(message, str):
            candidates.append(message)
    exception_message = getattr(exc, "message", None)
    if isinstance(exception_message, str):
        candidates.append(exception_message)
    text = " ".join(candidates).lower()
    return (
        "encrypted reasoning or compaction content" in text
        and "different model" in text
    ) or (
        "encrypted payloads can only be replayed" in text
        and "endpoint" in text
    )
