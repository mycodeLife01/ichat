import json
import re
from dataclasses import dataclass
from typing import cast
from urllib.parse import urlparse

from app.core.config import Settings
from app.providers import ProviderError, ToolSpec
from app.search.client import SearchClient
from app.search.postprocess import SourceRegistry, build_evidence
from app.search.types import (
    ExtractRequest,
    ExtractResult,
    SearchDepth,
    SearchRecency,
    SearchRequest,
    SearchResult,
)
from app.tools.types import ToolResult

_DOMAIN_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$", re.IGNORECASE)


WEB_SEARCH_TOOL_SPEC = ToolSpec(
    name="web_search",
    description=(
        "Search the live web and optionally extract top pages. Use it for current, "
        "time-sensitive, source-backed, URL, or official documentation questions."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The web search query."},
            "max_results": {
                "type": "integer",
                "description": "Number of search results to return, up to the server limit.",
                "minimum": 1,
                "maximum": 10,
            },
            "include_domains": {
                "type": "array",
                "description": "Optional domains that results must come from.",
                "items": {"type": "string"},
            },
            "exclude_domains": {
                "type": "array",
                "description": "Optional domains to exclude.",
                "items": {"type": "string"},
            },
            "recency": {
                "type": "string",
                "enum": ["day", "week", "month", "year", "none"],
                "description": "Optional recency filter.",
            },
            "search_depth": {
                "type": "string",
                "enum": ["basic", "advanced"],
                "description": "Latency/relevance tradeoff.",
            },
            "extract": {
                "type": "boolean",
                "description": "Whether to extract top result page text snippets.",
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
)


@dataclass(frozen=True)
class WebSearchArgs:
    query: str
    max_results: int
    include_domains: list[str] | None
    exclude_domains: list[str] | None
    recency: str
    search_depth: str
    extract: bool
    direct_urls: list[str] | None = None


def parse_tool_arguments(raw: str, *, settings: Settings) -> WebSearchArgs:
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("Tool arguments must be valid JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError("Tool arguments must be a JSON object.")
    allowed = {
        "query",
        "max_results",
        "include_domains",
        "exclude_domains",
        "recency",
        "search_depth",
        "extract",
    }
    extra = sorted(set(data) - allowed)
    if extra:
        raise ValueError(f"Unsupported web_search fields: {', '.join(extra)}.")
    query = data.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("web_search.query is required.")
    query = query.strip()
    if len(query) > 500:
        raise ValueError("web_search.query is too long.")
    max_results = data.get("max_results", settings.web_search_default_max_results)
    if not isinstance(max_results, int) or isinstance(max_results, bool):
        raise ValueError("web_search.max_results must be an integer.")
    if max_results < 1:
        raise ValueError("web_search.max_results must be at least 1.")
    max_results = min(max_results, settings.web_search_default_max_results)
    recency = data.get("recency", "none")
    if recency not in {"day", "week", "month", "year", "none"}:
        raise ValueError("web_search.recency is invalid.")
    search_depth = data.get("search_depth", "basic")
    if search_depth not in {"basic", "advanced"}:
        raise ValueError("web_search.search_depth is invalid.")
    include_domains = _validate_domains(data.get("include_domains"), "include_domains")
    exclude_domains = _validate_domains(data.get("exclude_domains"), "exclude_domains")
    extract = data.get("extract", False)
    if not isinstance(extract, bool):
        raise ValueError("web_search.extract must be a boolean.")
    return WebSearchArgs(
        query=query,
        max_results=max_results,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
        recency=recency,
        search_depth=search_depth,
        extract=extract,
        direct_urls=_extract_urls(query),
    )


async def run_web_search(
    *,
    args: WebSearchArgs,
    client: SearchClient,
    registry: SourceRegistry,
    settings: Settings,
) -> ToolResult:
    try:
        direct_extract_failed = False
        if args.direct_urls and args.extract:
            extracted, direct_extract_failed = await _extract_or_empty(
                client,
                ExtractRequest(
                    urls=args.direct_urls[: settings.web_search_max_extract_results],
                    query=args.query,
                    depth="advanced" if args.search_depth == "advanced" else "basic",
                    timeout_seconds=settings.web_search_extract_timeout_seconds,
                ),
            )
            if extracted:
                synthetic_results = [
                    SearchResult(
                        title=item.title or item.url,
                        url=item.url,
                        snippet=item.content,
                        provider=client.name,
                    )
                    for item in extracted
                ]
                records = registry.register(
                    synthetic_results,
                    extracted,
                    max_source_chars=settings.web_search_max_source_chars,
                )
                evidence = build_evidence(
                    records,
                    query=args.query,
                    max_chars=settings.web_search_max_evidence_chars,
                )
                return ToolResult(
                    status="succeeded",
                    content=evidence,
                    payload={
                        "provider": client.name,
                        "query": args.query,
                        "result_count": len(records),
                    },
                    sources=[record.event_summary() for record in records],
                )

        results = await client.search(
            SearchRequest(
                query=args.query,
                max_results=args.max_results,
                depth=cast(SearchDepth, args.search_depth),
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                recency=cast(SearchRecency, args.recency),
            )
        )
        extracts: list[ExtractResult] = []
        if args.extract and results and not direct_extract_failed:
            extracts, _ = await _extract_or_empty(
                client,
                ExtractRequest(
                    urls=[item.url for item in results[: settings.web_search_max_extract_results]],
                    query=args.query,
                    depth=cast(SearchDepth, args.search_depth),
                    timeout_seconds=settings.web_search_extract_timeout_seconds,
                )
            )
        records = registry.register(
            results,
            extracts,
            max_source_chars=settings.web_search_max_source_chars,
        )
        evidence = build_evidence(
            records,
            query=args.query,
            max_chars=settings.web_search_max_evidence_chars,
        )
        return ToolResult(
            status="succeeded",
            content=evidence,
            payload={
                "provider": client.name,
                "query": args.query,
                "result_count": len(records),
            },
            sources=[record.event_summary() for record in records],
        )
    except ProviderError as exc:
        return _failed(exc.code, exc.message, provider=client.name, query=args.query)
    except Exception as exc:
        return _failed(
            "search_error",
            "Web search failed. Continuing without live results.",
            provider=client.name,
            query=args.query,
            detail=str(exc),
        )


async def _extract_or_empty(
    client: SearchClient,
    request: ExtractRequest,
) -> tuple[list[ExtractResult], bool]:
    try:
        return await client.extract(request), False
    except ProviderError:
        return [], True
    except Exception:
        return [], True


def validation_failed_result(message: str, *, provider: str, query: str | None) -> ToolResult:
    return _failed("validation_error", message, provider=provider, query=query)


def unavailable_result(*, provider: str, query: str | None) -> ToolResult:
    return _failed(
        "web_search_unavailable",
        "Web search is not configured. Continuing without live results.",
        provider=provider,
        query=query,
    )


def _failed(
    code: str,
    message: str,
    *,
    provider: str,
    query: str | None,
    detail: str | None = None,
) -> ToolResult:
    payload = {
        "provider": provider,
        "query": query,
        "error_code": code,
        "message": message,
    }
    if detail:
        payload["detail"] = detail[:300]
    return ToolResult(
        status="failed",
        content=f"{message} ({code})",
        payload=payload,
        sources=[],
        error_code=code,
        message=message,
    )


def _validate_domains(value: object, field: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"web_search.{field} must be an array of domains.")
    domains = [item.strip().lower() for item in value if item.strip()]
    if len(domains) > 20:
        raise ValueError(f"web_search.{field} has too many domains.")
    invalid = [domain for domain in domains if not _DOMAIN_RE.match(domain)]
    if invalid:
        raise ValueError(f"web_search.{field} contains invalid domains.")
    return domains or None


def _extract_urls(text: str) -> list[str] | None:
    urls = re.findall(r"https?://[^\s<>\]\)\"']+", text, flags=re.IGNORECASE)
    cleaned = []
    for url in urls:
        parsed = urlparse(url)
        if parsed.scheme and parsed.netloc:
            cleaned.append(url)
    return cleaned or None
