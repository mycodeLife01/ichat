"""Provider registry for the orchestration layer.

Resolves a provider name to a concrete adapter, expanding the application
``Settings`` into each adapter's narrow constructor parameters. This is the one
place ``Settings`` meets a kernel provider — the kernel itself never imports
``Settings``.
"""

from app.agent.provider import Provider
from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.providers.openai import OpenAIProvider
from app.core.config import Settings


class UnknownProviderError(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown provider: {name}")
        self.name = name


def resolve_provider(name: str, *, settings: Settings) -> Provider:
    if name == "deepseek":
        return DeepSeekProvider(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            default_thinking_enabled=settings.deepseek_thinking_enabled,
            default_reasoning_effort=settings.deepseek_reasoning_effort,
        )
    if name == "openai":
        return OpenAIProvider(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
        )
    raise UnknownProviderError(name)
