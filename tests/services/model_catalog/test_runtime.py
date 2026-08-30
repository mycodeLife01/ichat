from unittest.mock import AsyncMock

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.providers.openrouter import OpenRouterProvider
from app.core.config import get_settings
from app.models.model_catalog import ModelUpstream
from app.models.run import Run
from app.services.model_catalog import resolve_run_model_runtime
from app.services.model_catalog.credentials import ModelCredentialCipher


async def test_run_runtime_uses_route_snapshot_but_current_encrypted_credential() -> None:
    encryption_key = ModelCredentialCipher.generate_key()
    cipher = ModelCredentialCipher(encryption_key)
    upstream = ModelUpstream(
        key="openrouter",
        label="OpenRouter",
        adapter="openai",
        base_url="https://edited-after-run.example/v1",
        api_key_ciphertext=cipher.encrypt("sk-current-key"),
        api_key_hint="…-key",
        enabled=False,
    )
    session = AsyncMock(spec=AsyncSession)
    session.scalar.return_value = upstream
    snapshot = {
        "version": 1,
        "catalog_model": "deepseek-v4",
        "route_id": 42,
        "upstream": "openrouter",
        "adapter": "openrouter",
        "base_url": "https://openrouter.example/api/v1",
        "provider_model": "deepseek/deepseek-chat",
        "thinking_levels": ["low", "high", "max"],
        "supports_image_input": False,
        "image_token_reserve": None,
        "token_profile": "deepseek",
    }
    run = Run(
        provider_name="openrouter",
        provider_model="deepseek/deepseek-chat",
        model_config_snapshot=snapshot,
    )
    settings = get_settings().model_copy(
        update={"model_catalog_encryption_key": encryption_key}
    )

    runtime = await resolve_run_model_runtime(session, run=run, settings=settings)

    assert isinstance(runtime.provider, OpenRouterProvider)
    assert runtime.provider._base_url == "https://openrouter.example/api/v1"
    assert runtime.provider._api_key == "sk-current-key"
    assert runtime.supports_reasoning is True
    assert runtime.reasoning_outputs == ()
    assert runtime.supports_image_input is False
    assert runtime.image_token_reserve == 0
    assert runtime.catalog_model == "deepseek-v4"


async def test_run_runtime_legacy_fallback_reports_provider_model_as_catalog_code() -> None:
    """Environment-mode runs have no snapshot; their catalog key equals the
    provider model string (see ``legacy_chat_models``)."""
    run = Run(provider_name="deepseek", provider_model="deepseek-v4-flash")
    settings = get_settings()

    runtime = await resolve_run_model_runtime(
        AsyncMock(spec=AsyncSession),
        run=run,
        settings=settings,
        legacy_resolver=lambda name, *, settings: object(),  # type: ignore[arg-type,return-value]
    )

    assert runtime.catalog_model == "deepseek-v4-flash"
