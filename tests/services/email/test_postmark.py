from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.services.email.postmark import (
    CONSOLE_PROVIDER,
    FAKE_PROVIDER,
    ConsoleProvider,
    EmailMessage,
    EmailSendError,
    FakeProvider,
    PostmarkProvider,
    get_email_provider,
)


def _message() -> EmailMessage:
    return EmailMessage(
        to="alice@example.com",
        subject="Verify your iChat email",
        html="<p>hi</p>",
        text="hi",
        tag="email_verification",
        metadata={"outbox_id": "1"},
    )


def _postmark_settings() -> SimpleNamespace:
    return SimpleNamespace(
        postmark_server_token="server-token",
        email_from="iChat <no-reply@mail.feslia.com>",
        email_reply_to="",
        postmark_message_stream="outbound",
        postmark_base_url="https://api.postmarkapp.com",
        postmark_timeout_seconds=10.0,
    )


def test_postmark_success_returns_message_id() -> None:
    response = MagicMock(status_code=200)
    response.json.return_value = {"MessageID": "mid-123"}
    with patch("app.services.email.postmark.httpx.post", return_value=response):
        result = PostmarkProvider(_postmark_settings()).send(_message())

    assert result.provider == "postmark"
    assert result.provider_message_id == "mid-123"


def test_postmark_5xx_is_retryable() -> None:
    response = MagicMock(status_code=500, text="server error")
    with patch("app.services.email.postmark.httpx.post", return_value=response):
        with pytest.raises(EmailSendError) as exc:
            PostmarkProvider(_postmark_settings()).send(_message())
    assert exc.value.retryable is True


def test_postmark_422_is_not_retryable() -> None:
    response = MagicMock(status_code=422, text="sender not confirmed")
    with patch("app.services.email.postmark.httpx.post", return_value=response):
        with pytest.raises(EmailSendError) as exc:
            PostmarkProvider(_postmark_settings()).send(_message())
    assert exc.value.retryable is False


def test_postmark_timeout_is_retryable() -> None:
    with patch(
        "app.services.email.postmark.httpx.post",
        side_effect=httpx.TimeoutException("timed out"),
    ):
        with pytest.raises(EmailSendError) as exc:
            PostmarkProvider(_postmark_settings()).send(_message())
    assert exc.value.retryable is True


def test_fake_provider_collects_and_can_fail() -> None:
    provider = FakeProvider()
    result = provider.send(_message())
    assert len(provider.sent) == 1
    assert result.provider_message_id == "fake-1"

    provider.fail_with = EmailSendError("boom", retryable=True)
    with pytest.raises(EmailSendError):
        provider.send(_message())


def test_console_provider_returns_no_message_id() -> None:
    result = ConsoleProvider().send(_message())
    assert result.provider == CONSOLE_PROVIDER
    assert result.provider_message_id is None


def test_get_email_provider_dispatches_by_setting() -> None:
    fake = get_email_provider(SimpleNamespace(email_provider=FAKE_PROVIDER))
    console = get_email_provider(SimpleNamespace(email_provider="console"))
    assert fake.__class__ is FakeProvider
    assert console.__class__ is ConsoleProvider
