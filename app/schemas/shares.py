from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ShareCreateRequest(BaseModel):
    """Owner request to mint a share link.

    ``expires_in_days`` omitted/None means the link never expires.
    """

    expires_in_days: int | None = Field(default=None, gt=0, le=365)


class SharedSource(BaseModel):
    """Mirror of MessageSource — the web-search citation kept in a snapshot.

    ``id`` is the per-message search-result ordinal (1, 2, 3...) and ``url`` is a
    public link; neither is an internal database id.
    """

    id: int
    title: str
    url: str
    snippet: str | None = None
    published_at: str | None = None
    provider: str | None = None


class SharedMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    reasoning: str | None = None
    sources: list[SharedSource] = Field(default_factory=list)


class PublicShareResponse(BaseModel):
    """Anonymous read payload — the frozen snapshot, no internal ids or user."""

    title: str | None
    messages: list[SharedMessage]
    created_at: datetime


class ShareLinkResponse(BaseModel):
    """Owner-only management view. Returns the full token so the UI can re-copy
    an existing link. Carries no internal ids or user identity — the management
    routes are already scoped to one conversation, and the UI builds the share
    URL from the token client-side.
    """

    token: str
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
