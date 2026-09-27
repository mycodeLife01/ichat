"""Version-controlled system prompt assembly for the orchestration layer.

``base_system_prompt.md`` is the bundled production prompt; ``build_system_prompt``
is the single assembly entry point. Dynamic run facts are appended as blocks:
the run's project model code (when provided) and, for runs with web search,
today's date plus web_search usage/citation guidance. Pure assembly — no DB,
no provider.
"""

from datetime import datetime
from functools import lru_cache
from pathlib import Path

from app.core.config import Settings

_BASE_PROMPT_PATH = Path(__file__).with_name("base_system_prompt.md")

_WEB_SEARCH_USAGE = (
    "You have a web_search tool. Call it when the answer depends on current, "
    "time-sensitive, or source-backed information — recent events, live data, "
    "prices, releases, or specific URLs and official docs. Skip it for questions "
    "you can answer reliably from your own knowledge."
)

# The call budget is per response, so the model must know it before fanning
# out; calls beyond it are rejected with a tool_call_limit error.
_WEB_SEARCH_PARALLEL = (
    "Calls issued in the same turn run in parallel, so when a question has "
    "independent parts (comparing several products, versions, or entities; "
    "several unrelated facts), issue one focused query per part in a single turn "
    "instead of searching one after another. Give each entity or sub-question "
    "its own query rather than packing several into one. Search sequentially "
    "only when a query depends on what an earlier result says; when a result "
    "reveals several items to look up, search them together in the next turn. "
    "Do not split one question "
    "into near-duplicate query variants."
)

# Extra model turns, not tool latency, dominate a searching run's wall time.
_WEB_SEARCH_STOP = (
    "The limit is a ceiling, not a target: stop searching as soon as the results "
    "you have are enough to answer, and do not search again just to double-check "
    "or to rephrase a query that already returned relevant results."
)

_CITATION_GUIDANCE = (
    "Citation format (the interface only recognizes this exact form):\n"
    "- When you rely on a search result, cite it inline right after the claim it "
    "supports, using its number in ASCII square brackets: [1].\n"
    "- Several sources: write one bracket per number, back to back: [2][3].\n"
    "- Only use numbers that web_search actually returned in this conversation. "
    "Never invent, guess, or renumber them. Source numbers are unique across the "
    "whole conversation: a number from an earlier web_search result still refers "
    "to that same source, so you may cite it again.\n"
    "- Never write: [1, 2], [1-3], 【1】, ［1］, (1), ¹, [^1], [source 1], "
    "[来源1], [#1], or a Markdown link such as [1](https://...).\n"
    "- Do not put citations inside code blocks or inline code, and do not add a "
    "references, sources, or footnotes section at the end."
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
    catalog_model: str | None = None,
) -> str:
    """Assemble the full system prompt sent to the provider for one run.

    ``catalog_model`` is the run's project model code (the catalog key), not the
    upstream provider's model name.
    """
    base = settings.default_system_prompt.strip() or bundled_base_prompt()
    blocks = [base]
    if catalog_model:
        blocks.append(
            f"Your model code is `{catalog_model}`. If asked which model you are, "
            "identify yourself with this code instead of an upstream model name."
        )
    if web_search_enabled:
        max_calls = settings.web_search_max_tool_calls
        budget = (
            f"You can make at most {max_calls} web_search calls in this response. "
            f"{_WEB_SEARCH_STOP}"
        )
        if max_calls > 1:
            budget = f"{budget} {_WEB_SEARCH_PARALLEL}"
        blocks.append(
            f"Today's date is {now:%Y-%m-%d} (UTC). {_WEB_SEARCH_USAGE}\n\n"
            f"{budget}\n\n{_CITATION_GUIDANCE}"
        )
    return "\n\n".join(blocks)
