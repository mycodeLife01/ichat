"""Version-controlled system prompt assembly for the orchestration layer.

``base_system_prompt.md`` is the bundled production prompt; ``build_system_prompt``
is the single assembly entry point. When a run registers web search, a dynamic
block with today's date and web_search usage/citation guidance is appended. Pure
assembly — no DB, no provider.
"""

from datetime import datetime
from functools import lru_cache
from pathlib import Path

from app.core.config import Settings

_BASE_PROMPT_PATH = Path(__file__).with_name("base_system_prompt.md")

_WEB_SEARCH_GUIDANCE = (
    "You have a web_search tool. Call it when the answer depends on current, "
    "time-sensitive, or source-backed information — recent events, live data, "
    "prices, releases, or specific URLs and official docs. Skip it for questions "
    "you can answer reliably from your own knowledge. When you rely on a search "
    "result, cite it inline using its bracketed number, e.g. [1] or [2][3], "
    "matching the source numbers returned by web_search. Do not use footnote "
    "syntax such as [^1] or a separate footnotes section."
)


@lru_cache
def bundled_base_prompt() -> str:
    """The version-controlled production base prompt shipped in this package."""
    return _BASE_PROMPT_PATH.read_text(encoding="utf-8").strip()


def build_system_prompt(
    *,
    settings: Settings,
    web_search_enabled: bool,
    now: datetime,
) -> str:
    """Assemble the full system prompt sent to the provider for one run."""
    base = settings.default_system_prompt.strip() or bundled_base_prompt()
    if not web_search_enabled:
        return base
    return f"{base}\n\nToday's date is {now:%Y-%m-%d} (UTC). {_WEB_SEARCH_GUIDANCE}"
