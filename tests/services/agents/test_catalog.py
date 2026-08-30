"""Legacy catalog fallback tests used before the database catalog is activated."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.services.model_catalog import available_chat_models, resolve_chat_model


def settings_with(**overrides: object):
    return get_settings().model_copy(update=overrides)


def legacy_session() -> AsyncMock:
    session = AsyncMock(spec=AsyncSession)
    session.get.return_value = None
    return session


async def test_catalog_defaults_to_deepseek_flash_and_pro_without_openai_key() -> None:
    settings = settings_with(openai_api_key="")

    models = await available_chat_models(legacy_session(), settings=settings)

    assert [model.key for model in models] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert [model.thinking_levels for model in models] == [
        ("low", "high", "max"),
        ("high", "max"),
    ]
    assert all(model.provider_name == "deepseek" for model in models)


async def test_catalog_lists_openai_models_with_full_levels_and_stripped_label() -> None:
    settings = settings_with(
        openai_api_key="sk-test",
        openai_models="openai/gpt-5.6-luna, gpt-5-mini",
    )

    models = await available_chat_models(legacy_session(), settings=settings)

    assert [(model.key, model.label) for model in models[2:]] == [
        ("openai/gpt-5.6-luna", "gpt-5.6-luna"),
        ("gpt-5-mini", "gpt-5-mini"),
    ]
    assert all(
        model.thinking_levels == ("low", "medium", "high", "xhigh", "max")
        for model in models[2:]
    )


async def test_catalog_gives_non_reasoning_openai_models_no_thinking_levels() -> None:
    settings = settings_with(openai_api_key="sk-test", openai_models="gpt-4.1-mini")

    models = await available_chat_models(legacy_session(), settings=settings)

    assert models[-1].thinking_levels == ()


async def test_resolve_chat_model_none_selects_default_flash() -> None:
    settings = settings_with(openai_api_key="sk-test")

    entry = await resolve_chat_model(
        legacy_session(),
        settings=settings,
        requested_model=None,
    )

    assert entry.provider_name == "deepseek"
    assert entry.provider_model == "deepseek-v4-flash"


async def test_resolve_chat_model_maps_openai_model_to_provider() -> None:
    settings = settings_with(openai_api_key="sk-test", openai_models="openai/gpt-5.6-luna")

    entry = await resolve_chat_model(
        legacy_session(),
        settings=settings,
        requested_model="openai/gpt-5.6-luna",
    )

    assert entry.provider_name == "openai"
    assert entry.provider_model == "openai/gpt-5.6-luna"


async def test_resolve_chat_model_rejects_unknown_model() -> None:
    settings = settings_with(openai_api_key="sk-test", openai_models="gpt-5-mini")

    with pytest.raises(AppError) as exc_info:
        await resolve_chat_model(
            legacy_session(),
            settings=settings,
            requested_model="gpt-imaginary",
        )

    assert exc_info.value.status_code == 422


async def test_resolve_chat_model_rejects_openai_model_when_key_missing() -> None:
    settings = settings_with(openai_api_key="", openai_models="gpt-5-mini")

    with pytest.raises(AppError):
        await resolve_chat_model(
            legacy_session(),
            settings=settings,
            requested_model="gpt-5-mini",
        )
