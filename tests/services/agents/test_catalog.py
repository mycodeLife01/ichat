"""Catalog tests: which chat models are selectable, their thinking levels and
labels, and how a request's ``model`` resolves to a (provider, model) pair."""

import pytest

from app.core.config import get_settings
from app.core.errors import AppError
from app.services.agents.catalog import (
    ChatModel,
    available_chat_models,
    resolve_chat_model,
)


def settings_with(**overrides):
    return get_settings().model_copy(update=overrides)


def test_catalog_defaults_to_deepseek_flash_and_pro_without_openai_key() -> None:
    settings = settings_with(openai_api_key="")

    models = available_chat_models(settings)

    assert models == [
        ChatModel(
            provider_name="deepseek",
            model="deepseek-v4-flash",
            label="deepseek-v4-flash",
            thinking_levels=("low", "high", "max"),
        ),
        ChatModel(
            provider_name="deepseek",
            model="deepseek-v4-pro",
            label="deepseek-v4-pro",
            thinking_levels=("high", "max"),
        ),
    ]


def test_catalog_lists_openai_models_with_full_levels_and_stripped_label() -> None:
    settings = settings_with(
        openai_api_key="sk-test", openai_models="openai/gpt-5.6-luna, gpt-5-mini"
    )

    models = available_chat_models(settings)

    assert models[2:] == [
        ChatModel(
            provider_name="openai",
            model="openai/gpt-5.6-luna",
            label="gpt-5.6-luna",
            thinking_levels=("low", "medium", "high", "xhigh", "max"),
        ),
        ChatModel(
            provider_name="openai",
            model="gpt-5-mini",
            label="gpt-5-mini",
            thinking_levels=("low", "medium", "high", "xhigh", "max"),
        ),
    ]


def test_catalog_gives_non_reasoning_openai_models_no_thinking_levels() -> None:
    settings = settings_with(openai_api_key="sk-test", openai_models="gpt-4.1-mini")

    models = available_chat_models(settings)

    assert models[-1].thinking_levels == ()


def test_resolve_chat_model_none_selects_default_flash() -> None:
    settings = settings_with(openai_api_key="sk-test")

    entry = resolve_chat_model(settings, None)

    assert entry.provider_name == "deepseek"
    assert entry.model == "deepseek-v4-flash"


def test_resolve_chat_model_maps_openai_model_to_provider() -> None:
    settings = settings_with(openai_api_key="sk-test", openai_models="openai/gpt-5.6-luna")

    entry = resolve_chat_model(settings, "openai/gpt-5.6-luna")

    assert entry.provider_name == "openai"
    assert entry.model == "openai/gpt-5.6-luna"


def test_resolve_chat_model_rejects_unknown_model() -> None:
    settings = settings_with(openai_api_key="sk-test", openai_models="gpt-5-mini")

    with pytest.raises(AppError) as exc_info:
        resolve_chat_model(settings, "gpt-imaginary")

    assert exc_info.value.status_code == 422


def test_resolve_chat_model_rejects_openai_model_when_key_missing() -> None:
    settings = settings_with(openai_api_key="", openai_models="gpt-5-mini")

    with pytest.raises(AppError):
        resolve_chat_model(settings, "gpt-5-mini")
