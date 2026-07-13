"""Email template rendering.

Templates are code (functions), not files — there is no template management
backend in v1. Each renderer takes the outbox ``payload`` and returns the
subject + HTML + plain-text bodies.
"""

import html
from dataclasses import dataclass
from typing import Any

EMAIL_VERIFICATION_TEMPLATE = "email_verification"
EMAIL_VERIFICATION_SUBJECT = "Verify your iChat email"
PASSWORD_RESET_TEMPLATE = "password_reset"
PASSWORD_RESET_SUBJECT = "Reset your iChat password"

# Email clients ignore external stylesheets and most modern CSS, so the layout
# uses nested tables with inline styles (the only portable approach). Colors
# mirror the frontend theme in frontend/src/styles/global.css.
_CARD_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f3f0;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" \
style="background-color:#f4f3f0;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" \
style="max-width:480px;">
<tr><td style="padding:0 8px 20px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,\
Arial,sans-serif;font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#1a1a19;">\
iChat</td></tr>
<tr><td style="background-color:#ffffff;border:1px solid rgba(20,20,19,0.08);\
border-radius:12px;padding:36px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\
font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#1a1a19;padding-bottom:12px;">\
{heading}</td></tr>
<tr><td style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\
font-size:15px;line-height:1.6;color:#6b6a66;padding-bottom:28px;">{intro}</td></tr>
<tr><td align="center" style="padding-bottom:28px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="background-color:#1a1a19;border-radius:8px;">\
<a href="{action_url}" style="display:inline-block;padding:12px 32px;\
font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;\
font-weight:600;color:#fbfbfa;text-decoration:none;">{button_label}</a></td></tr>
</table>
</td></tr>
<tr><td style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\
font-size:13px;line-height:1.6;color:#95938e;border-top:1px solid rgba(20,20,19,0.08);\
padding-top:20px;">If the button does not work, copy and paste this link into your \
browser:<br><a href="{action_url}" style="color:#1a1a19;word-break:break-all;">\
{action_url_text}</a></td></tr>
<tr><td style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\
font-size:13px;line-height:1.6;color:#95938e;padding-top:12px;">{expiry_line}</td></tr>
</table>
</td></tr>
<tr><td style="padding:20px 8px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,\
Arial,sans-serif;font-size:12px;line-height:1.6;color:#b8b6b0;">{footer_line}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
"""


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    html: str
    text: str


def _render_card_html(
    *,
    subject: str,
    preheader: str,
    heading: str,
    intro: str,
    button_label: str,
    action_url: str,
    expiry_line: str,
    footer_line: str,
) -> str:
    return _CARD_HTML.format(
        subject=html.escape(subject),
        preheader=html.escape(preheader),
        heading=html.escape(heading),
        intro=html.escape(intro),
        button_label=html.escape(button_label),
        action_url=html.escape(action_url, quote=True),
        action_url_text=html.escape(action_url),
        expiry_line=html.escape(expiry_line),
        footer_line=html.escape(footer_line),
    )


def render_email_verification(payload: dict[str, Any]) -> RenderedEmail:
    verification_url = payload["verification_url"]
    username = payload.get("username") or "there"
    expires_in_hours = payload.get("expires_in_hours")
    expiry_line = (
        f"This link expires in {expires_in_hours} hours."
        if expires_in_hours
        else "This link will expire soon."
    )
    footer_line = "If you did not create an iChat account, you can safely ignore this email."

    text = (
        f"Hi {username},\n\n"
        "Confirm your email to secure your iChat account by opening this link:\n"
        f"{verification_url}\n\n"
        f"{expiry_line}\n\n"
        "If you did not create an iChat account, you can ignore this email."
    )
    html_body = _render_card_html(
        subject=EMAIL_VERIFICATION_SUBJECT,
        preheader="Confirm your email to finish setting up your iChat account.",
        heading="Verify your email",
        intro=f"Hi {username}, confirm your email address to secure your iChat account.",
        button_label="Verify my email",
        action_url=verification_url,
        expiry_line=expiry_line,
        footer_line=footer_line,
    )
    return RenderedEmail(subject=EMAIL_VERIFICATION_SUBJECT, html=html_body, text=text)


def render_password_reset(payload: dict[str, Any]) -> RenderedEmail:
    reset_url = payload["reset_url"]
    username = payload.get("username") or "there"
    expires_in_minutes = payload.get("expires_in_minutes")
    expiry_line = (
        f"This link expires in {expires_in_minutes} minutes and can be used once."
        if expires_in_minutes
        else "This link will expire soon and can be used once."
    )
    footer_line = (
        "If you did not request a password reset, you can safely ignore this "
        "email — your password will not change."
    )

    text = (
        f"Hi {username},\n\n"
        "We received a request to reset your iChat password. Set a new password "
        "by opening this link:\n"
        f"{reset_url}\n\n"
        f"{expiry_line}\n\n"
        f"{footer_line}"
    )
    html_body = _render_card_html(
        subject=PASSWORD_RESET_SUBJECT,
        preheader="Set a new password for your iChat account.",
        heading="Reset your password",
        intro=(
            f"Hi {username}, we received a request to reset your iChat password. "
            "Click the button below to set a new one."
        ),
        button_label="Reset my password",
        action_url=reset_url,
        expiry_line=expiry_line,
        footer_line=footer_line,
    )
    return RenderedEmail(subject=PASSWORD_RESET_SUBJECT, html=html_body, text=text)


_RENDERERS = {
    EMAIL_VERIFICATION_TEMPLATE: render_email_verification,
    PASSWORD_RESET_TEMPLATE: render_password_reset,
}


def render(template: str, payload: dict[str, Any]) -> RenderedEmail:
    try:
        renderer = _RENDERERS[template]
    except KeyError as exc:
        raise ValueError(f"Unknown email template: {template!r}") from exc
    return renderer(payload)
