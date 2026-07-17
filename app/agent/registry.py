from app.agent.providers.deepseek import DeepSeekProvider
from app.core.config import Settings

from .provider import Provider


class UnknownProviderError(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown provider: {name}")
        self.name = name


def resolve_provider(name: str, *, settings: Settings) -> Provider:
    if name == "deepseek":
        return DeepSeekProvider(settings=settings)
    raise UnknownProviderError(name)
