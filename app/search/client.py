from typing import Protocol

from app.search.types import ExtractRequest, ExtractResult, SearchRequest, SearchResult


class SearchClient(Protocol):
    @property
    def name(self) -> str: ...

    async def search(self, request: SearchRequest) -> list[SearchResult]: ...

    async def extract(self, request: ExtractRequest) -> list[ExtractResult]: ...
