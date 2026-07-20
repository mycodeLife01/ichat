from app.search.client import SearchClient, SearchError
from app.search.postprocess import SourceRecord, SourceRegistry, build_evidence
from app.search.registry import UnknownSearchProviderError, resolve_search_client
from app.search.types import (
    ExtractRequest,
    ExtractResult,
    SearchRequest,
    SearchResult,
)

__all__ = [
    "ExtractRequest",
    "ExtractResult",
    "SearchClient",
    "SearchError",
    "SearchRequest",
    "SearchResult",
    "SourceRecord",
    "SourceRegistry",
    "UnknownSearchProviderError",
    "build_evidence",
    "resolve_search_client",
]
