from app.core.config import Settings
from app.core.errors import AppError
from app.search.client import SearchClient
from app.search.tavily import TavilySearchClient, aclose_shared_client


class UnknownSearchProviderError(AppError):
    def __init__(self, provider_name: str) -> None:
        super().__init__(500, f"Unknown search provider: {provider_name}")


def resolve_search_client(name: str, *, settings: Settings) -> SearchClient:
    if name == "tavily":
        return TavilySearchClient(settings=settings)
    raise UnknownSearchProviderError(name)


async def aclose_search_clients() -> None:
    """Release pooled search connections; call once when the worker stops."""
    await aclose_shared_client()
