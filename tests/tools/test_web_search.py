from app.core.config import Settings, get_settings
from app.providers import ProviderError
from app.search.postprocess import SourceRegistry
from app.search.types import ExtractRequest, SearchRequest, SearchResult
from app.tools.web_search import WebSearchArgs, run_web_search


def search_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "web_search_default_max_results": 5,
            "web_search_max_extract_results": 2,
            "web_search_max_evidence_chars": 2_000,
            "web_search_max_source_chars": 400,
        }
    )


async def test_run_web_search_falls_back_to_search_when_direct_extract_fails() -> None:
    class FakeSearchClient:
        name = "tavily"

        def __init__(self) -> None:
            self.calls: list[str] = []

        async def extract(self, request: ExtractRequest) -> list[object]:
            self.calls.append(f"extract:{request.urls[0]}")
            raise ProviderError(code="timeout", message="extract timed out")

        async def search(self, request: SearchRequest) -> list[SearchResult]:
            self.calls.append(f"search:{request.query}")
            return [
                SearchResult(
                    title="Release notes",
                    url="https://example.com/releases",
                    snippet="Version 1.2 shipped.",
                    provider=self.name,
                )
            ]

    client = FakeSearchClient()

    result = await run_web_search(
        args=WebSearchArgs(
            query="总结 https://example.com/releases",
            max_results=5,
            include_domains=None,
            exclude_domains=None,
            recency="none",
            search_depth="basic",
            extract=True,
            direct_urls=["https://example.com/releases"],
        ),
        client=client,
        registry=SourceRegistry(),
        settings=search_settings(),
    )

    assert client.calls == [
        "extract:https://example.com/releases",
        "search:总结 https://example.com/releases",
    ]
    assert result.status == "succeeded"
    assert result.payload["result_count"] == 1
    assert result.sources == [
        {"id": 1, "title": "Release notes", "url": "https://example.com/releases"}
    ]
    assert "Version 1.2 shipped." in result.content


async def test_run_web_search_uses_search_results_when_result_extract_fails() -> None:
    class FakeSearchClient:
        name = "tavily"

        async def search(self, request: SearchRequest) -> list[SearchResult]:
            return [
                SearchResult(
                    title="Official docs",
                    url="https://docs.example.com/api",
                    snippet="The current API version is v2.",
                    provider=self.name,
                )
            ]

        async def extract(self, request: ExtractRequest) -> list[object]:
            raise ProviderError(code="tavily_extract_error", message="extract failed")

    result = await run_web_search(
        args=WebSearchArgs(
            query="current API docs",
            max_results=5,
            include_domains=None,
            exclude_domains=None,
            recency="none",
            search_depth="advanced",
            extract=True,
        ),
        client=FakeSearchClient(),
        registry=SourceRegistry(),
        settings=search_settings(),
    )

    assert result.status == "succeeded"
    assert result.payload["result_count"] == 1
    assert result.sources[0]["title"] == "Official docs"
    assert "The current API version is v2." in result.content
