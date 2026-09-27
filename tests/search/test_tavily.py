import json

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.search import tavily
from app.search.registry import aclose_search_clients
from app.search.tavily import TavilySearchClient
from app.search.types import ExtractRequest, SearchRequest


def search_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "tavily_api_key": "tvly-test",
            "tavily_base_url": "https://tavily.example",
        }
    )


async def test_tavily_search_maps_request_and_normalizes_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/search"
        assert request.headers["authorization"] == "Bearer tvly-test"
        payload = json.loads(request.content)
        assert payload == {
            "query": "latest iChat release",
            "search_depth": "advanced",
            "max_results": 3,
            "include_answer": False,
            "include_raw_content": False,
            "include_images": False,
            "include_favicon": True,
            "time_range": "week",
            "include_domains": ["example.com"],
            "exclude_domains": ["spam.example"],
        }
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Release notes",
                        "url": "https://example.com/releases",
                        "content": "Version 1.2 shipped.",
                        "score": 0.9,
                        "published_date": "2026-06-11",
                    },
                    {"title": "Missing URL"},
                ]
            },
        )

    client = TavilySearchClient(
        settings=search_settings(),
        transport=httpx.MockTransport(handler),
    )

    results = await client.search(
        SearchRequest(
            query="latest iChat release",
            max_results=3,
            depth="advanced",
            include_domains=["example.com"],
            exclude_domains=["spam.example"],
            recency="week",
        )
    )

    assert len(results) == 1
    assert results[0].title == "Release notes"
    assert results[0].url == "https://example.com/releases"
    assert results[0].snippet == "Version 1.2 shipped."
    assert results[0].score == 0.9
    assert results[0].published_at == "2026-06-11"
    assert results[0].provider == "tavily"


async def test_tavily_extract_maps_request_and_normalizes_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/extract"
        payload = json.loads(request.content)
        assert payload == {
            "urls": ["https://example.com/releases"],
            "extract_depth": "basic",
            "format": "text",
            "include_images": False,
            "include_favicon": False,
            "timeout": 4.0,
            "query": "release summary",
            "chunks_per_source": 3,
        }
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "url": "https://example.com/releases",
                        "title": "Release notes",
                        "raw_content": "Full extracted text.",
                    },
                    {"url": "https://example.com/empty", "raw_content": ""},
                ]
            },
        )

    client = TavilySearchClient(
        settings=search_settings(),
        transport=httpx.MockTransport(handler),
    )

    results = await client.extract(
        ExtractRequest(
            urls=["https://example.com/releases"],
            query="release summary",
            depth="basic",
            timeout_seconds=4.0,
        )
    )

    assert len(results) == 1
    assert results[0].url == "https://example.com/releases"
    assert results[0].title == "Release notes"
    assert results[0].content == "Full extracted text."
    assert results[0].provider == "tavily"


async def test_tavily_without_transport_reuses_one_pooled_client() -> None:
    settings = search_settings()
    try:
        first = tavily._get_shared_client(settings)
        second = tavily._get_shared_client(settings)

        assert first is second
        assert str(first.base_url).rstrip("/") == settings.tavily_base_url.rstrip("/")
    finally:
        await aclose_search_clients()

    assert first.is_closed
    reopened = tavily._get_shared_client(settings)
    try:
        assert reopened is not first
    finally:
        await aclose_search_clients()


async def test_tavily_without_transport_sends_through_pooled_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, str, float | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        read_timeout = request.extensions["timeout"]["read"]
        seen.append((request.url.path, request.headers["authorization"], read_timeout))
        return httpx.Response(200, json={"results": []})

    settings = search_settings()
    pooled = httpx.AsyncClient(
        base_url=settings.tavily_base_url, transport=httpx.MockTransport(handler)
    )
    monkeypatch.setattr(tavily, "_get_shared_client", lambda _settings: pooled)
    client = TavilySearchClient(settings=settings)

    try:
        await client.search(SearchRequest(query="a", max_results=1))
        await client.extract(ExtractRequest(urls=["https://example.com"]))
    finally:
        await pooled.aclose()

    assert seen == [
        ("/search", "Bearer tvly-test", settings.web_search_search_timeout_seconds),
        ("/extract", "Bearer tvly-test", settings.web_search_extract_timeout_seconds),
    ]
