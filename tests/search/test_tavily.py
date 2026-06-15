import json

import httpx

from app.core.config import Settings, get_settings
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
