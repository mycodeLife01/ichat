from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest

from app.services.email.providers import (
    RESEND_PROVIDER,
    EmailMessage,
    EmailSendError,
    ResendProvider,
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


def _resend_settings() -> SimpleNamespace:
    return SimpleNamespace(
        resend_api_key="re_test_key",
        email_from="iChat <no-reply@mail.feslia.com>",
        email_reply_to="",
        resend_base_url="https://api.resend.com",
        resend_timeout_seconds=10.0,
    )


def test_resend_success_returns_message_id() -> None:
    response = MagicMock(status_code=200)
    response.json.return_value = {"id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}
    with patch("app.services.email.providers.httpx.post", return_value=response) as post:
        result = ResendProvider(_resend_settings()).send(_message())

    assert result.provider == RESEND_PROVIDER
    assert result.provider_message_id == "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"

    kwargs = post.call_args.kwargs
    assert post.call_args.args[0] == "https://api.resend.com/emails"
    assert kwargs["headers"]["Authorization"] == "Bearer re_test_key"
    body = kwargs["json"]
    assert body["to"] == ["alice@example.com"]
    assert {"name": "tag", "value": "email_verification"} in body["tags"]
    assert {"name": "outbox_id", "value": "1"} in body["tags"]


def test_resend_5xx_is_retryable() -> None:
    response = MagicMock(status_code=500, text="server error")
    with patch("app.services.email.providers.httpx.post", return_value=response):
        with pytest.raises(EmailSendError) as exc:
            ResendProvider(_resend_settings()).send(_message())
    assert exc.value.retryable is True


def test_resend_429_is_retryable() -> None:
    response = MagicMock(status_code=429, text="rate limit exceeded")
    with patch("app.services.email.providers.httpx.post", return_value=response):
        with pytest.raises(EmailSendError) as exc:
            ResendProvider(_resend_settings()).send(_message())
    assert exc.value.retryable is True


def test_resend_422_is_not_retryable() -> None:
    response = MagicMock(status_code=422, text="invalid from address")
    with patch("app.services.email.providers.httpx.post", return_value=response):
        with pytest.raises(EmailSendError) as exc:
            ResendProvider(_resend_settings()).send(_message())
    assert exc.value.retryable is False


def test_resend_timeout_is_retryable() -> None:
    with patch(
        "app.services.email.providers.httpx.post",
        side_effect=httpx.TimeoutException("timed out"),
    ):
        with pytest.raises(EmailSendError) as exc:
            ResendProvider(_resend_settings()).send(_message())
    assert exc.value.retryable is True


def test_get_email_provider_dispatches_resend() -> None:
    provider = get_email_provider(
        SimpleNamespace(email_provider=RESEND_PROVIDER, **_resend_settings().__dict__)
    )
    assert provider.__class__ is ResendProvider
