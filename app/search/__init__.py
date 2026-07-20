"""Provider-agnostic search infrastructure.

The package root re-exports only the *pure* surface — the ``SearchClient``
protocol, result types, and the ``SourceRegistry`` / evidence postprocessing —
so the agent kernel can depend on ``app.search`` without transitively importing
``app.core.config``. The ``Settings``-bound registry and adapters
(``resolve_search_client``, ``TavilySearchClient``) live in ``app.search.registry``
and are imported explicitly by the orchestration layer, never the kernel.
"""

from app.search.client import SearchClient, SearchError
from app.search.postprocess import SourceRecord, SourceRegistry, build_evidence
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
    "build_evidence",
]
