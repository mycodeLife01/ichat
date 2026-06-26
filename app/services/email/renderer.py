"""Email template rendering.

Templates are code (functions), not files — there is no template management
backend in v1. Each renderer takes the outbox ``payload`` and returns the
subject + HTML + plain-text bodies.
"""

from dataclasses import dataclass
from typing import Any

EMAIL_VERIFICATION_TEMPLATE = "email_verification"
EMAIL_VERIFICATION_SUBJECT = "Verify your iChat email"


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    html: str
    text: str


def render_email_verification(payload: dict[str, Any]) -> RenderedEmail:
    verification_url = payload["verification_url"]
    username = payload.get("username") or "there"
    expires_in_hours = payload.get("expires_in_hours")
    expiry_line = (
        f"This link expires in {expires_in_hours} hours."
        if expires_in_hours
        else "This link will expire soon."
    )

    text = (
        f"Hi {username},\n\n"
        "Confirm your email to secure your iChat account by opening this link:\n"
        f"{verification_url}\n\n"
        f"{expiry_line}\n\n"
        "If you did not create an iChat account, you can ignore this email."
    )
    html = (
        f"<p>Hi {username},</p>"
        "<p>Confirm your email to secure your iChat account.</p>"
        f'<p><a href="{verification_url}">Verify my email</a></p>'
        f"<p>{expiry_line}</p>"
        "<p>If you did not create an iChat account, you can ignore this email.</p>"
    )
    return RenderedEmail(subject=EMAIL_VERIFICATION_SUBJECT, html=html, text=text)


_RENDERERS = {EMAIL_VERIFICATION_TEMPLATE: render_email_verification}


def render(template: str, payload: dict[str, Any]) -> RenderedEmail:
    try:
        renderer = _RENDERERS[template]
    except KeyError as exc:
        raise ValueError(f"Unknown email template: {template!r}") from exc
    return renderer(payload)
