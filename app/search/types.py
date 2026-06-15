from dataclasses import dataclass
from typing import Literal

SearchDepth = Literal["basic", "advanced"]
SearchRecency = Literal["day", "week", "month", "year", "none"]


@dataclass(frozen=True)
class SearchRequest:
    query: str
    max_results: int
    depth: SearchDepth = "basic"
    include_domains: list[str] | None = None
    exclude_domains: list[str] | None = None
    recency: SearchRecency = "none"


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    score: float | None = None
    published_at: str | None = None
    provider: str = "tavily"


@dataclass(frozen=True)
class ExtractRequest:
    urls: list[str]
    query: str | None = None
    depth: SearchDepth = "basic"
    timeout_seconds: float | None = None


@dataclass(frozen=True)
class ExtractResult:
    url: str
    content: str
    title: str | None = None
    provider: str = "tavily"


@dataclass(frozen=True)
class PlannedSearch:
    query: str
    max_results: int | None = None
    depth: SearchDepth = "basic"
    recency: SearchRecency = "none"
    extract: bool = False
    include_domains: list[str] | None = None
    exclude_domains: list[str] | None = None
    direct_urls: list[str] | None = None
