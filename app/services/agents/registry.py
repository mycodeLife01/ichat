"""Provider adapter registry for the orchestration layer.

Resolves a provider name to a concrete adapter, expanding the application
``Settings`` into each adapter's narrow constructor parameters. This is the one
place ``Settings`` meets a kernel provider — the kernel itself never imports
``Settings``.
"""

from dataclasses import dataclass, field
from typing import Literal

from app.agent.messages import ReasoningKind
from app.agent.provider import Provider
from app.agent.providers.deepseek import DeepSeekProvider
from app.agent.providers.openai import OpenAIProvider
from app.agent.providers.openrouter import OpenRouterProvider
from app.core.config import Settings

ProviderAdapter = Literal["deepseek", "openai", "openrouter"]


@dataclass(frozen=True)
class ProviderConnection:
    adapter: ProviderAdapter
    api_key: str = field(repr=False)
    base_url: str
    token_profile: str = "default"
    default_thinking_enabled: bool = False
    default_reasoning_effort: str = "high"
    reasoning_outputs: tuple[ReasoningKind, ...] = ()


class UnknownProviderError(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown provider: {name}")
        self.name = name


def resolve_provider(name: str, *, settings: Settings) -> Provider:
    if name == "deepseek":
        return build_provider(
            ProviderConnection(
                adapter="deepseek",
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
                token_profile="deepseek",
                default_thinking_enabled=settings.deepseek_thinking_enabled,
                default_reasoning_effort=settings.deepseek_reasoning_effort,
            )
        )
    if name == "openai":
        return build_provider(
            ProviderConnection(
                adapter="openai",
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
                token_profile="openai",
                # Preserve legacy OpenAI-compatible ENV behavior. Database
                # routes carry an explicit route-level output contract.
                reasoning_outputs=("raw",),
            )
        )
    raise UnknownProviderError(name)


def build_provider(connection: ProviderConnection) -> Provider:
    if connection.adapter == "deepseek":
        return DeepSeekProvider(
            api_key=connection.api_key,
            base_url=connection.base_url,
            default_thinking_enabled=connection.default_thinking_enabled,
            default_reasoning_effort=connection.default_reasoning_effort,
        )
    if connection.adapter == "openai":
        return OpenAIProvider(
            api_key=connection.api_key,
            base_url=connection.base_url,
            reasoning_outputs=connection.reasoning_outputs,
        )
    if connection.adapter == "openrouter":
        return OpenRouterProvider(
            api_key=connection.api_key,
            base_url=connection.base_url,
            token_profile=connection.token_profile,
            reasoning_outputs=connection.reasoning_outputs,
        )
    raise UnknownProviderError(connection.adapter)
