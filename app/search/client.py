from typing import Protocol

from app.search.types import ExtractRequest, ExtractResult, SearchRequest, SearchResult


class SearchError(Exception):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class SearchClient(Protocol):
    @property
    def name(self) -> str: ...

    async def search(self, request: SearchRequest) -> list[SearchResult]: ...

    async def extract(self, request: ExtractRequest) -> list[ExtractResult]: ...
