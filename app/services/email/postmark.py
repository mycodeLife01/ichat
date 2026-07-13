"""Email provider adapters.

``postmark`` uses the Postmark HTTP API for transactional email. ``console``
logs the message (local dev). ``fake`` collects messages in memory (tests).
Synchronous on purpose — these run inside the Celery worker process.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import httpx
from loguru import logger

from app.core.config import Settings

POSTMARK_PROVIDER = "postmark"
CONSOLE_PROVIDER = "console"
FAKE_PROVIDER = "fake"

# Postmark error codes / HTTP statuses that will never succeed on retry.
_NON_RETRYABLE_STATUSES = frozenset({401, 403, 422})


@dataclass
class EmailMessage:
    to: str
    subject: str
    html: str
    text: str
    tag: str | None = None
    metadata: dict[str, str] | None = None


@dataclass
class SendResult:
    provider: str
    provider_message_id: str | None


class EmailSendError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class EmailProvider(Protocol):
    def send(self, message: EmailMessage) -> SendResult: ...


class PostmarkProvider:
    def __init__(self, settings: Settings) -> None:
        self._token = settings.postmark_server_token
        self._from = settings.email_from
        self._reply_to = settings.email_reply_to
        self._stream = settings.postmark_message_stream
        self._base_url = settings.postmark_base_url.rstrip("/")
        self._timeout = settings.postmark_timeout_seconds

    def send(self, message: EmailMessage) -> SendResult:
        body: dict[str, object] = {
            "From": self._from,
            "To": message.to,
            "Subject": message.subject,
            "HtmlBody": message.html,
            "TextBody": message.text,
            "MessageStream": self._stream,
        }
        if self._reply_to:
            body["ReplyTo"] = self._reply_to
        if message.tag:
            body["Tag"] = message.tag
        if message.metadata:
            body["Metadata"] = message.metadata

        try:
            response = httpx.post(
                f"{self._base_url}/email",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "X-Postmark-Server-Token": self._token,
                },
                json=body,
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            # Network/timeout: transient.
            raise EmailSendError(f"Postmark request failed: {exc}", retryable=True) from exc

        if response.status_code == 200:
            message_id = response.json().get("MessageID")
            return SendResult(provider=POSTMARK_PROVIDER, provider_message_id=message_id)

        retryable = response.status_code not in _NON_RETRYABLE_STATUSES and (
            response.status_code >= 500 or response.status_code == 429
        )
        raise EmailSendError(
            f"Postmark returned {response.status_code}: {response.text[:500]}",
            retryable=retryable,
        )


class ConsoleProvider:
    def send(self, message: EmailMessage) -> SendResult:
        logger.info(
            "Console email | to={to} | subject={subject}\n{text}",
            to=message.to,
            subject=message.subject,
            text=message.text,
        )
        return SendResult(provider=CONSOLE_PROVIDER, provider_message_id=None)


@dataclass
class FakeProvider:
    """In-memory provider for tests. Inspect/clear ``sent``."""

    sent: list[EmailMessage] = field(default_factory=list)
    fail_with: EmailSendError | None = None

    def send(self, message: EmailMessage) -> SendResult:
        if self.fail_with is not None:
            raise self.fail_with
        self.sent.append(message)
        return SendResult(provider=FAKE_PROVIDER, provider_message_id=f"fake-{len(self.sent)}")


# Stable singleton so tests (and the running app under EMAIL_PROVIDER=fake) share
# the same collected messages.
fake_provider = FakeProvider()


def get_email_provider(settings: Settings) -> EmailProvider:
    if settings.email_provider == POSTMARK_PROVIDER:
        return PostmarkProvider(settings)
    if settings.email_provider == FAKE_PROVIDER:
        return fake_provider
    return ConsoleProvider()
