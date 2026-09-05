import json
from pathlib import Path

import pytest

from app.services.conversations.search_text import (
    build_assistant_search_text,
    build_user_search_text,
    normalize_query,
    title_match_range,
    utf16_length,
)

CASES = json.loads(
    (Path(__file__).parents[2] / "fixtures/conversation_search_text_v1.json").read_text()
)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_text(case):
    result = (
        build_user_search_text(case["content"])
        if case["role"] == "user"
        else build_assistant_search_text(case["content"], frozenset(case.get("sources", [])))
    )
    assert result == case["text"]


def test_query_and_utf16():
    assert normalize_query(" \tABC\n中文Ä ") == "abc 中文Ä"
    assert utf16_length("😀中文") == 4
    assert title_match_range("😀ABC\t\n中文", "abc 中文") == (2, 9)
