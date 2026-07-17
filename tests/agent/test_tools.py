import pytest

from app.agent.tools import (
    Tool,
    ToolRegistry,
    ToolResult,
    ToolSpec,
    WebSearchTool,
)
from app.agent.tools.web_search import WEB_SEARCH_TOOL_SPEC
from app.core.config import Settings, get_settings
from app.search.types import ExtractRequest, SearchRequest, SearchResult


def search_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "web_search_enabled": True,
            "tavily_api_key": "test-key",
            "web_search_default_max_results": 5,
            "web_search_max_extract_results": 2,
            "web_search_max_evidence_chars": 2_000,
            "web_search_max_source_chars": 400,
        }
    )


class _StubTool:
    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(name=self._name, description="stub", parameters={"type": "object"})

    async def execute(self, arguments: dict) -> ToolResult:
        return ToolResult(content="ok")


def test_registry_dispatch_and_specs() -> None:
    tool = _StubTool("alpha")
    registry = ToolRegistry([tool])

    assert "alpha" in registry
    assert registry.get("alpha") is tool
    assert registry.get("missing") is None
    assert [spec.name for spec in registry.specs()] == ["alpha"]
    assert registry.names() == ["alpha"]
    assert len(registry) == 1


def test_registry_rejects_duplicate() -> None:
    registry = ToolRegistry([_StubTool("alpha")])
    with pytest.raises(ValueError):
        registry.register(_StubTool("alpha"))


def test_tool_result_is_tool_agnostic() -> None:
    # Only content + is_error + a free-form metadata dict — no tool-specific fields.
    result = ToolResult(content="hi")
    assert result.is_error is False
    assert result.metadata == {}


def test_web_search_tool_satisfies_protocol() -> None:
    tool = WebSearchTool(settings=search_settings())
    assert isinstance(tool, Tool)
    assert tool.name == "web_search"
    assert tool.spec is WEB_SEARCH_TOOL_SPEC


async def test_web_search_tool_executes_and_returns_sources_in_metadata() -> None:
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
            return []

    tool = WebSearchTool(settings=search_settings(), client=FakeSearchClient())

    result = await tool.execute({"query": "current API docs"})

    assert result.is_error is False
    assert result.metadata["result_count"] == 1
    assert result.metadata["sources"][0]["title"] == "Official docs"
    assert "The current API version is v2." in result.content


async def test_web_search_tool_rejects_invalid_arguments() -> None:
    tool = WebSearchTool(settings=search_settings())

    result = await tool.execute({"query": ""})

    assert result.is_error is True
    assert result.metadata["error_code"] == "validation_error"


async def test_web_search_tool_reports_unavailable_when_not_configured() -> None:
    disabled = get_settings().model_copy(update={"web_search_enabled": False})
    tool = WebSearchTool(settings=disabled)

    result = await tool.execute({"query": "anything"})

    assert result.is_error is True
    assert result.metadata["error_code"] == "web_search_unavailable"


async def test_web_search_tool_wraps_client_errors() -> None:
    from app.agent.provider import ProviderError

    class BoomClient:
        name = "tavily"

        async def search(self, request: SearchRequest) -> list[SearchResult]:
            raise ProviderError(code="tavily_error", message="upstream boom")

        async def extract(self, request: ExtractRequest) -> list[object]:
            return []

    tool = WebSearchTool(settings=search_settings(), client=BoomClient())

    result = await tool.execute({"query": "current API docs"})

    assert result.is_error is True
    assert result.metadata["error_code"] == "tavily_error"


async def test_web_search_tool_accumulates_sources_across_calls() -> None:
    class FakeSearchClient:
        name = "tavily"

        def __init__(self) -> None:
            self._n = 0

        async def search(self, request: SearchRequest) -> list[SearchResult]:
            self._n += 1
            return [
                SearchResult(
                    title=f"Doc {self._n}",
                    url=f"https://docs.example.com/{self._n}",
                    snippet="snippet",
                    provider=self.name,
                )
            ]

        async def extract(self, request: ExtractRequest) -> list[object]:
            return []

    tool = WebSearchTool(settings=search_settings(), client=FakeSearchClient())
    await tool.execute({"query": "first"})
    await tool.execute({"query": "second"})

    # The tool owns its per-run SourceRegistry; citation numbering stays stable.
    assert len(tool.sources.all_metadata()) == 2
