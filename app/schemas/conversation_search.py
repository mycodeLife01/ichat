"""Bounded search results. Offsets use UTF-16 half-open intervals."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class SearchRange(BaseModel):
    start: int
    end: int


class SearchSnippet(BaseModel):
    text: str
    match: SearchRange
    truncated_before: bool
    truncated_after: bool


class SearchTarget(SearchRange):
    message_id: UUID
    field: Literal["body", "reply_quote"]
    projection_version: Literal[1] = 1
    projection_hash: str


class ConversationSearchItem(BaseModel):
    conversation_id: UUID
    title: str | None
    updated_at: datetime
    title_match: SearchRange | None = None
    snippet: SearchSnippet | None = None
    target: SearchTarget | None = None


class ConversationSearchResponse(BaseModel):
    items: list[ConversationSearchItem]
    next_cursor: str | None = None
