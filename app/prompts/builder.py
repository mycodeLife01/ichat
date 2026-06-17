from datetime import datetime
from functools import lru_cache
from pathlib import Path

from app.core.config import Settings

_BASE_PROMPT_PATH = Path(__file__).with_name("base_system_prompt.md")

# Appended only when the run has the web_search tool registered. Lives here, with
# the rest of prompt assembly, so the full system prompt has a single source of
# truth rather than being concatenated ad hoc in the worker.
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
    """Assemble the full system prompt sent to the provider for one run.

    The base prompt is the bundled production prompt unless
    ``settings.default_system_prompt`` carries a non-empty override. When the run
    has web search registered, a dynamic block with today's date and the
    web_search usage/citation guidance is appended.
    """
    base = settings.default_system_prompt.strip() or bundled_base_prompt()
    if not web_search_enabled:
        return base
    return f"{base}\n\nToday's date is {now:%Y-%m-%d} (UTC). {_WEB_SEARCH_GUIDANCE}"
