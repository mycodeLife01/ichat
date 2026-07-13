import pytest

from app.services.email.renderer import (
    ACCOUNT_DELETION_SUBJECT,
    ACCOUNT_DELETION_TEMPLATE,
    EMAIL_VERIFICATION_SUBJECT,
    EMAIL_VERIFICATION_TEMPLATE,
    PASSWORD_RESET_SUBJECT,
    PASSWORD_RESET_TEMPLATE,
    render,
    render_account_deletion,
    render_email_verification,
    render_password_reset,
)


def test_render_email_verification_includes_link_and_user() -> None:
    url = "https://chat.feslia.com/verify-email?token=abc123"
    rendered = render_email_verification(
        {"verification_url": url, "username": "alice", "expires_in_hours": 24}
    )

    assert rendered.subject == EMAIL_VERIFICATION_SUBJECT
    assert url in rendered.html
    assert url in rendered.text
    assert "alice" in rendered.text
    assert "24 hours" in rendered.text


def test_render_email_verification_tolerates_missing_optional_fields() -> None:
    rendered = render_email_verification({"verification_url": "https://x/verify"})
    assert "there" in rendered.text  # default greeting
    assert "https://x/verify" in rendered.html


def test_render_dispatches_by_template() -> None:
    rendered = render(EMAIL_VERIFICATION_TEMPLATE, {"verification_url": "https://x/verify"})
    assert rendered.subject == EMAIL_VERIFICATION_SUBJECT


def test_render_password_reset_includes_link_user_and_expiry() -> None:
    url = "https://chat.feslia.com/reset-password?token=abc123"
    rendered = render_password_reset(
        {"reset_url": url, "username": "alice", "expires_in_minutes": 30}
    )

    assert rendered.subject == PASSWORD_RESET_SUBJECT
    assert url in rendered.html
    assert url in rendered.text
    assert "alice" in rendered.text
    assert "30 minutes" in rendered.text


def test_render_dispatches_password_reset() -> None:
    rendered = render(PASSWORD_RESET_TEMPLATE, {"reset_url": "https://x/reset"})
    assert rendered.subject == PASSWORD_RESET_SUBJECT


def test_render_account_deletion_includes_link_warning_and_expiry() -> None:
    url = "https://chat.feslia.com/confirm-account-deletion?token=abc123"
    rendered = render_account_deletion(
        {"deletion_url": url, "username": "alice", "expires_in_minutes": 30}
    )

    assert rendered.subject == ACCOUNT_DELETION_SUBJECT
    assert url in rendered.html
    assert url in rendered.text
    assert "alice" in rendered.text
    assert "30 minutes" in rendered.text
    # "If this wasn't you" warning must be present in both bodies.
    assert "change your password" in rendered.text
    assert "change your password" in rendered.html


def test_render_dispatches_account_deletion() -> None:
    rendered = render(ACCOUNT_DELETION_TEMPLATE, {"deletion_url": "https://x/del"})
    assert rendered.subject == ACCOUNT_DELETION_SUBJECT


def test_render_unknown_template_raises() -> None:
    with pytest.raises(ValueError):
        render("no-such-template", {"verification_url": "https://x"})
