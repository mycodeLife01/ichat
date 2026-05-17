from collections.abc import AsyncIterator

from app.core.config import Settings
from app.providers.types import Provider, ProviderChunk, ProviderMessage


class DeepSeekProvider(Provider):
    def __init__(self, *, settings: Settings) -> None:
        self._settings = settings

    @property
    def name(self) -> str:
        return "deepseek"

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]:
        raise NotImplementedError("DeepSeek streaming is implemented in a later task")
        yield  # pragma: no cover  # keeps function an async generator for typing
