"""Catalog of user-selectable chat models.

The single source of truth for which (provider, model) pairs a run may use:
the capabilities endpoint lists it, and every run-creating route validates the
requested model against it before persisting ``provider_name`` /
``provider_model`` on the run row. Availability is credential-gated the same
way web search is — an unconfigured provider's models simply don't appear.

Each entry also declares its selectable thinking levels (the neutral effort
scale) and a display label (aggregator ids like ``openai/gpt-5.6-luna`` are
shown without the vendor prefix).
"""

from dataclasses import dataclass

from fastapi import status

from app.agent.providers.openai import supports_reasoning_control
from app.core.config import Settings
from app.core.errors import AppError

UNSUPPORTED_MODEL_MESSAGE = "Requested model is not available"

# Neutral thinking-effort tiers, weakest to strongest.
_DEEPSEEK_FLASH_LEVELS = ("low", "high", "max")
_DEEPSEEK_PRO_LEVELS = ("high", "max")
_OPENAI_LEVELS = ("low", "medium", "high", "xhigh", "max")


@dataclass(frozen=True)
class ChatModel:
    provider_name: str
    model: str
    label: str
    thinking_levels: tuple[str, ...]
    supports_image_input: bool = False
    image_token_reserve: int | None = None


def _display_label(model: str) -> str:
    """Strip an aggregator vendor prefix (``openai/gpt-5.6-luna`` → ``gpt-5.6-luna``)."""
    return model.rsplit("/", 1)[-1]


def _deepseek_levels(model: str) -> tuple[str, ...]:
    # The pro tier is always-thinking; it has no low/fast mode.
    if _display_label(model).endswith("-pro"):
        return _DEEPSEEK_PRO_LEVELS
    return _DEEPSEEK_FLASH_LEVELS


def _openai_levels(model: str) -> tuple[str, ...]:
    if supports_reasoning_control(model):
        return _OPENAI_LEVELS
    return ()


def available_chat_models(settings: Settings) -> list[ChatModel]:
    """All selectable chat models; the first entry is the default."""
    models = [
        ChatModel(
            provider_name="deepseek",
            model=model,
            label=_display_label(model),
            thinking_levels=_deepseek_levels(model),
            supports_image_input=False,
            image_token_reserve=None,
        )
        for model in settings.deepseek_models_list
    ]
    if settings.openai_available:
        vision_models = set(settings.openai_vision_models_list)
        models.extend(
            ChatModel(
                provider_name="openai",
                model=model,
                label=_display_label(model),
                thinking_levels=_openai_levels(model),
                supports_image_input=model in vision_models,
                image_token_reserve=(
                    settings.openai_image_token_reserve if model in vision_models else None
                ),
            )
            for model in settings.openai_models_list
        )
    return models


def resolve_chat_model(settings: Settings, requested_model: str | None) -> ChatModel:
    """Map a request's optional ``model`` to a catalog entry.

    ``None`` selects the default (first) entry; an unknown model is a client
    error, not a fallback — silently substituting a model the user did not pick
    would misattribute the answer.
    """
    models = available_chat_models(settings)
    if requested_model is None:
        return models[0]
    for entry in models:
        if entry.model == requested_model:
            return entry
    raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, UNSUPPORTED_MODEL_MESSAGE)
