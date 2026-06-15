from typing import Any

import httpx

from app.core.config import Settings
from app.providers import ProviderError
from app.search.client import SearchClient
from app.search.types import ExtractRequest, ExtractResult, SearchRequest, SearchResult

_RECENCY_TO_TIME_RANGE = {
    "day": "day",
    "week": "week",
    "month": "month",
    "year": "year",
}


class TavilySearchClient(SearchClient):
    def __init__(
        self,
        *,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport

    @property
    def name(self) -> str:
        return "tavily"

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        payload: dict[str, Any] = {
            "query": request.query,
            "search_depth": request.depth,
            "max_results": request.max_results,
            "include_answer": False,
            "include_raw_content": False,
            "include_images": False,
            "include_favicon": True,
        }
        if request.recency != "none":
            payload["time_range"] = _RECENCY_TO_TIME_RANGE[request.recency]
        if request.include_domains:
            payload["include_domains"] = request.include_domains
        if request.exclude_domains:
            payload["exclude_domains"] = request.exclude_domains

        data = await self._post_json(
            "/search",
            payload=payload,
            timeout_seconds=self._settings.web_search_search_timeout_seconds,
            error_code="tavily_search_error",
        )
        results = data.get("results")
        if not isinstance(results, list):
            return []
        normalized: list[SearchResult] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url:
                continue
            title = item.get("title")
            content = item.get("content")
            published_at = item.get("published_date") or item.get("published_at")
            score = item.get("score")
            normalized.append(
                SearchResult(
                    title=title if isinstance(title, str) and title else url,
                    url=url,
                    snippet=content if isinstance(content, str) else "",
                    score=float(score) if isinstance(score, int | float) else None,
                    published_at=published_at if isinstance(published_at, str) else None,
                    provider=self.name,
                )
            )
        return normalized

    async def extract(self, request: ExtractRequest) -> list[ExtractResult]:
        payload: dict[str, Any] = {
            "urls": request.urls,
            "extract_depth": request.depth,
            "format": "text",
            "include_images": False,
            "include_favicon": False,
            "timeout": request.timeout_seconds
            or self._settings.web_search_extract_timeout_seconds,
        }
        if request.query:
            payload["query"] = request.query
            payload["chunks_per_source"] = 3

        data = await self._post_json(
            "/extract",
            payload=payload,
            timeout_seconds=self._settings.web_search_extract_timeout_seconds,
            error_code="tavily_extract_error",
        )
        results = data.get("results")
        if not isinstance(results, list):
            return []
        extracted: list[ExtractResult] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            content = item.get("raw_content")
            title = item.get("title")
            if isinstance(url, str) and isinstance(content, str) and content:
                extracted.append(
                    ExtractResult(
                        url=url,
                        content=content,
                        title=title if isinstance(title, str) else None,
                        provider=self.name,
                    )
                )
        return extracted

    async def _post_json(
        self,
        path: str,
        *,
        payload: dict[str, Any],
        timeout_seconds: float,
        error_code: str,
    ) -> dict[str, Any]:
        client_kwargs: dict[str, Any] = {
            "base_url": self._settings.tavily_base_url,
            "timeout": httpx.Timeout(timeout_seconds, connect=5.0),
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport
        headers = {
            "Authorization": f"Bearer {self._settings.tavily_api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        async with httpx.AsyncClient(**client_kwargs) as client:
            try:
                response = await client.post(path, json=payload, headers=headers)
            except httpx.TimeoutException as exc:
                raise ProviderError(
                    code="timeout",
                    message="Web search timed out. Continuing without live results.",
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(code=error_code, message=str(exc)) from exc
        if response.status_code >= 400:
            raise ProviderError(
                code=error_code,
                message=(
                    f"Tavily returned {response.status_code}: "
                    f"{response.text[:300]}"
                ),
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise ProviderError(
                code=error_code,
                message="Tavily returned invalid JSON.",
            ) from exc
        if not isinstance(data, dict):
            raise ProviderError(code=error_code, message="Tavily returned invalid JSON.")
        return data
