from datetime import UTC, datetime

from app.core.config import Settings, get_settings
from app.prompts import build_system_prompt, bundled_base_prompt

_NOW = datetime(2026, 6, 17, tzinfo=UTC)


def _settings(override: str) -> Settings:
    return get_settings().model_copy(update={"default_system_prompt": override})


def test_uses_bundled_base_prompt_when_no_override() -> None:
    prompt = build_system_prompt(settings=_settings(""), web_search_enabled=False, now=_NOW)
    assert prompt == bundled_base_prompt()
    assert "AI assistant" in prompt


def test_override_replaces_bundled_base_prompt() -> None:
    prompt = build_system_prompt(
        settings=_settings("Custom base."), web_search_enabled=False, now=_NOW
    )
    assert prompt == "Custom base."


def test_web_search_appends_date_and_guidance() -> None:
    prompt = build_system_prompt(settings=_settings("Base."), web_search_enabled=True, now=_NOW)
    assert prompt.startswith("Base.\n\n")
    assert "Today's date is 2026-06-17 (UTC)." in prompt
    assert "web_search tool" in prompt
    assert "[1]" in prompt  # inline citation guidance is retained


def test_no_web_search_omits_date_and_guidance() -> None:
    prompt = build_system_prompt(settings=_settings("Base."), web_search_enabled=False, now=_NOW)
    assert "Today's date" not in prompt
    assert "web_search" not in prompt
