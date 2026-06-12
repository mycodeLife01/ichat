from dataclasses import dataclass
from urllib.parse import urlparse

from app.search.types import ExtractResult, SearchResult


@dataclass
class SourceRecord:
    id: int
    title: str
    url: str
    snippet: str
    published_at: str | None
    provider: str

    def metadata(self) -> dict[str, object]:
        return {
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "published_at": self.published_at,
            "provider": self.provider,
        }

    def event_summary(self) -> dict[str, object]:
        return {"id": self.id, "title": self.title, "url": self.url}


class SourceRegistry:
    def __init__(self) -> None:
        self._by_url: dict[str, SourceRecord] = {}
        self._ordered: list[SourceRecord] = []

    def register(
        self,
        results: list[SearchResult],
        extracts: list[ExtractResult],
        *,
        max_source_chars: int,
    ) -> list[SourceRecord]:
        extract_by_url = {_normalize_url(item.url): item for item in extracts}
        records: list[SourceRecord] = []
        for result in results:
            key = _normalize_url(result.url)
            existing = self._by_url.get(key)
            if existing is not None:
                records.append(existing)
                continue
            extract = extract_by_url.get(key)
            snippet = extract.content if extract is not None else result.snippet
            title = extract.title or result.title if extract is not None else result.title
            record = SourceRecord(
                id=len(self._ordered) + 1,
                title=title or result.url,
                url=result.url,
                snippet=_squeeze(snippet, max_source_chars),
                published_at=result.published_at,
                provider=result.provider,
            )
            self._by_url[key] = record
            self._ordered.append(record)
            records.append(record)
        return records

    def all_metadata(self) -> list[dict[str, object]]:
        return [record.metadata() for record in self._ordered]


def build_evidence(
    sources: list[SourceRecord],
    *,
    query: str,
    max_chars: int,
) -> str:
    parts = [
        "以下是 web_search 工具返回的压缩证据。请只在这些来源支持时引用编号。",
        f"查询：{query}",
    ]
    for source in sources:
        domain = urlparse(source.url).netloc
        published = f"\n发布时间：{source.published_at}" if source.published_at else ""
        parts.append(
            f"[{source.id}] {source.title}\n"
            f"URL: {source.url}\n"
            f"域名：{domain}{published}\n"
            f"摘录：{source.snippet}"
        )
    return _squeeze("\n\n".join(parts), max_chars)


def _normalize_url(url: str) -> str:
    parsed = urlparse(url.strip())
    scheme = parsed.scheme.lower() or "https"
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    return f"{scheme}://{netloc}{path}?{parsed.query}" if parsed.query else f"{scheme}://{netloc}{path}"


def _squeeze(text: str, max_chars: int) -> str:
    compact = " ".join(text.split())
    if len(compact) <= max_chars:
        return compact
    return f"{compact[: max_chars - 1].rstrip()}…"
