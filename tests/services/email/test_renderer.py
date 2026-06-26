import pytest

from app.services.email.renderer import (
    EMAIL_VERIFICATION_SUBJECT,
    EMAIL_VERIFICATION_TEMPLATE,
    render,
    render_email_verification,
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


def test_render_unknown_template_raises() -> None:
    with pytest.raises(ValueError):
        render("password_reset", {"verification_url": "https://x"})
