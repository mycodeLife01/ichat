import pytest

from app.core.config import get_settings
from app.providers import Provider
from app.providers.registry import UnknownProviderError, resolve_provider


def test_resolve_provider_returns_deepseek_for_known_name() -> None:
    provider = resolve_provider("deepseek", settings=get_settings())

    assert isinstance(provider, Provider)
    assert provider.name == "deepseek"


def test_resolve_provider_rejects_unknown_name() -> None:
    with pytest.raises(UnknownProviderError) as exc_info:
        resolve_provider("unknown-provider", settings=get_settings())

    assert "unknown-provider" in str(exc_info.value)
