import re
from collections.abc import Iterable, Mapping
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
        # Enough for a live citation chip and its hover card while the run is
        # still streaming; the full snippet lands in the message metadata.
        return {
            "id": self.id,
            "title": self.title,
            "url": self.url,
            "snippet": _squeeze(self.snippet, _EVENT_SNIPPET_CHARS),
            "published_at": self.published_at,
        }


_EVENT_SNIPPET_CHARS = 300
_CITATION = re.compile(r"\[(\d+)\]")
_FENCED_CODE = re.compile(r"(`{3,}|~{3,}).*?(?:\1|$)", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")


class SourceRegistry:
    """Numbers one run's search sources within the conversation's citation space.

    Citation ids are unique across a conversation: ``prior`` carries the sources
    stored on earlier visible assistant messages, a URL seen before keeps its
    id, and new sources continue after the highest prior id. Legacy messages
    numbered each run from 1, so a prior id that maps to different URLs is
    ambiguous; it is never reused nor resolved as a citation.
    """

    def __init__(self, prior: Iterable[Mapping[str, object]] = ()) -> None:
        self._by_url: dict[str, SourceRecord] = {}
        self._ordered: list[SourceRecord] = []
        prior_by_id: dict[int, SourceRecord] = {}
        ambiguous: set[int] = set()
        max_id = 0
        for item in prior:
            record = _record_from_metadata(item)
            if record is None:
                continue
            max_id = max(max_id, record.id)
            existing = prior_by_id.setdefault(record.id, record)
            if _normalize_url(existing.url) != _normalize_url(record.url):
                ambiguous.add(record.id)
        for source_id in ambiguous:
            del prior_by_id[source_id]
        self._prior_by_id = prior_by_id
        self._prior_by_url: dict[str, SourceRecord] = {}
        for record in prior_by_id.values():
            self._prior_by_url.setdefault(_normalize_url(record.url), record)
        self._next_id = max_id + 1

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
            prior = self._prior_by_url.get(key)
            if prior is not None:
                source_id = prior.id
            else:
                source_id = self._next_id
                self._next_id += 1
            record = SourceRecord(
                id=source_id,
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

    def assistant_sources(self, text: str) -> list[dict[str, object]]:
        """This run's sources plus earlier-turn sources the final text cites."""
        collected = self.all_metadata()
        seen = {record.id for record in self._ordered}
        for source_id in cited_source_ids(text):
            prior = self._prior_by_id.get(source_id)
            if prior is not None and source_id not in seen:
                collected.append(prior.metadata())
                seen.add(source_id)
        return collected


def cited_source_ids(text: str) -> list[int]:
    """``[n]`` citation ids in answer text, in order, ignoring code spans."""
    prose = _INLINE_CODE.sub(" ", _FENCED_CODE.sub(" ", text))
    return [int(match.group(1)) for match in _CITATION.finditer(prose)]


def _record_from_metadata(item: Mapping[str, object]) -> SourceRecord | None:
    source_id = item.get("id")
    url = item.get("url")
    if not isinstance(source_id, int) or isinstance(source_id, bool) or source_id <= 0:
        return None
    if not isinstance(url, str) or not url:
        return None
    title = item.get("title")
    snippet = item.get("snippet")
    published_at = item.get("published_at")
    provider = item.get("provider")
    return SourceRecord(
        id=source_id,
        title=title if isinstance(title, str) and title else url,
        url=url,
        snippet=snippet if isinstance(snippet, str) else "",
        published_at=published_at if isinstance(published_at, str) else None,
        provider=provider if isinstance(provider, str) else "",
    )


def build_evidence(
    sources: list[SourceRecord],
    *,
    query: str,
    max_chars: int,
) -> str:
    parts = [
        "以下是 web_search 工具返回的压缩证据。请只在这些来源支持时引用编号。",
        "引用格式：在对应陈述后紧跟半角方括号编号，如 [1]；多个来源写成 [1][2]。"
        "不要写成 [1,2]、[1-2]、【1】、[^1]、[来源1] 或 [1](URL)，也不要在文末列参考来源。",
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
