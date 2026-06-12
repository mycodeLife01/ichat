import re
from datetime import UTC, datetime
from typing import cast
from urllib.parse import urlparse

from app.search.types import PlannedSearch, SearchDepth, SearchRecency

_URL_RE = re.compile(r"https?://[^\s<>\]\)\"']+", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"\b(?:site:)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b", re.IGNORECASE)

_SEARCH_SIGNALS = (
    "联网",
    "搜索",
    "查一下",
    "查网页",
    "source",
    "cite",
    "引用来源",
    "今天",
    "现在",
    "最新",
    "今年",
    "刚发布",
    "recent",
    "latest",
    "current",
    "价格",
    "汇率",
    "新闻",
    "天气",
    "股票",
    "版本",
    "release",
    "api docs",
    "官网文档",
)

_NO_SEARCH_SIGNALS = (
    "不要联网",
    "别联网",
    "不用联网",
    "不要搜索",
    "别搜索",
    "不用搜索",
    "无需联网",
    "无需搜索",
    "no web search",
    "without web search",
    "do not search",
    "don't search",
    "dont search",
    "no internet",
)

_PURE_LOCAL_SIGNALS = (
    "翻译",
    "改写",
    "润色",
    "总结下面",
    "解释这段代码",
    "代码解释",
)

_EXTRACT_SIGNALS = (
    "总结这个链接",
    "分析这个链接",
    "这个链接",
    "官方文档",
    "api 版本",
    "引用来源",
    "cite",
    "source",
)


def suppresses_web_search(text: str) -> bool:
    normalized = text.lower()
    return any(signal in normalized for signal in _NO_SEARCH_SIGNALS)


def should_presearch(text: str) -> bool:
    normalized = text.lower()
    if suppresses_web_search(normalized):
        return False
    if _URL_RE.search(text) or "site:" in normalized:
        return True
    if any(signal in normalized for signal in _SEARCH_SIGNALS):
        return True
    if any(signal in normalized for signal in _PURE_LOCAL_SIGNALS):
        return False
    return False


def plan_search(text: str, *, now: datetime | None = None) -> PlannedSearch:
    now = now or datetime.now(UTC)
    urls = _URL_RE.findall(text)
    domains = _extract_site_domains(text)
    normalized = " ".join(text.strip().split())
    query = normalized
    if len(query) > 400:
        query = query[:400].rstrip()
    realtime_signals = ("今天", "现在", "最新", "recent", "latest", "current")
    if any(signal in normalized.lower() for signal in realtime_signals):
        query = f"{query} (current as of {now:%Y-%m-%d})"
    extract = bool(urls) or any(signal in normalized.lower() for signal in _EXTRACT_SIGNALS)
    recency = "month" if any(
        signal in normalized.lower()
        for signal in ("今天", "现在", "最新", "recent", "latest", "current", "新闻")
    ) else "none"
    depth = "advanced" if extract or recency != "none" else "basic"
    return PlannedSearch(
        query=query,
        depth=cast(SearchDepth, depth),
        recency=cast(SearchRecency, recency),
        extract=extract,
        include_domains=domains or None,
        direct_urls=urls or None,
    )


def _extract_site_domains(text: str) -> list[str]:
    domains: list[str] = []
    for match in re.finditer(r"\bsite:([a-z0-9.-]+\.[a-z]{2,})\b", text, re.IGNORECASE):
        domains.append(match.group(1).lower())
    if domains:
        return domains
    urls = _URL_RE.findall(text)
    for url in urls:
        parsed = urlparse(url)
        if parsed.hostname:
            domains.append(parsed.hostname.lower())
    return list(dict.fromkeys(domains))
