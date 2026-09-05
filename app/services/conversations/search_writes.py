"""Maintain search representations within the caller's business transaction."""

from app.models.conversation import Message
from app.services.conversations.search_text import (
    SEARCH_TEXT_VERSION,
    build_assistant_search_text,
    build_user_search_text,
    search_text_hash,
)


def populate_message_search_text(message: Message) -> None:
    sources = (message.metadata_ or {}).get("sources", [])
    source_ids = frozenset(
        s["id"] for s in sources if isinstance(s, dict) and isinstance(s.get("id"), int)
    )
    message.search_text = (
        build_assistant_search_text(message.content, source_ids)
        if message.role == "assistant"
        else build_user_search_text(message.content)
    )
    message.search_quote_text = build_user_search_text(message.reply_quote_excerpt or "")
    message.search_text_hash = search_text_hash(message.search_text)
    message.search_quote_hash = search_text_hash(message.search_quote_text)
    message.search_text_version = SEARCH_TEXT_VERSION
