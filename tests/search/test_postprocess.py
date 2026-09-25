from app.search.postprocess import SourceRegistry, cited_source_ids
from app.search.types import SearchResult


def result(url: str, title: str = "t") -> SearchResult:
    return SearchResult(title=title, url=url, snippet="snippet", provider="tavily")


def prior(source_id: int, url: str) -> dict[str, object]:
    return {
        "id": source_id,
        "title": f"Prior {source_id}",
        "url": url,
        "snippet": "old snippet",
        "published_at": None,
        "provider": "tavily",
    }


def test_new_sources_continue_after_highest_prior_id() -> None:
    registry = SourceRegistry([prior(1, "https://a.test"), prior(2, "https://b.test")])

    records = registry.register([result("https://c.test")], [], max_source_chars=100)

    assert [record.id for record in records] == [3]


def test_repeated_url_keeps_its_prior_id() -> None:
    registry = SourceRegistry([prior(1, "https://a.test/page/")])

    records = registry.register(
        [result("https://A.test/page"), result("https://new.test")],
        [],
        max_source_chars=100,
    )

    assert [record.id for record in records] == [1, 2]
    assert records[0].snippet == "snippet"


def test_legacy_colliding_prior_ids_are_never_reused_or_resolved() -> None:
    # Legacy runs each numbered from 1, so id 1 means two different URLs.
    registry = SourceRegistry([prior(1, "https://a.test"), prior(1, "https://b.test")])

    records = registry.register([result("https://a.test")], [], max_source_chars=100)

    assert [record.id for record in records] == [2]
    assert [item["id"] for item in registry.assistant_sources("See [1] and [2].")] == [2]


def test_assistant_sources_append_cited_prior_sources_once() -> None:
    registry = SourceRegistry(
        [prior(1, "https://a.test"), prior(2, "https://b.test"), prior(3, "https://c.test")]
    )
    registry.register([result("https://new.test")], [], max_source_chars=100)

    sources = registry.assistant_sources("New [4], earlier [2][2] and [9].")

    assert [item["id"] for item in sources] == [4, 2]
    assert sources[1]["title"] == "Prior 2"


def test_assistant_sources_without_search_resolve_prior_citations() -> None:
    registry = SourceRegistry([prior(1, "https://a.test")])

    assert [item["id"] for item in registry.assistant_sources("As noted [1].")] == [1]
    assert registry.assistant_sources("No citations.") == []


def test_cited_source_ids_ignore_code() -> None:
    text = "Cite [1].\n\n```python\nitems[2]\n```\n\nInline `xs[3]` and [4]."

    assert cited_source_ids(text) == [1, 4]


def test_event_summary_carries_short_snippet() -> None:
    registry = SourceRegistry()
    [record] = registry.register(
        [SearchResult(title="t", url="https://a.test", snippet="x" * 1000, provider="tavily")],
        [],
        max_source_chars=1000,
    )

    summary = record.event_summary()

    assert summary["id"] == 1
    assert len(str(summary["snippet"])) <= 300
    assert summary["published_at"] is None
