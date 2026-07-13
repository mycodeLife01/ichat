import pytest
from pydantic import ValidationError

from app.schemas.auth import LoginRequest, RegisterRequest, VerifyEmailRequest


def test_register_request_strips_username_before_validation() -> None:
    request = RegisterRequest(
        username=" alice ",
        email="alice@example.com",
        password="correct-password",
    )

    assert request.username == "alice"


def test_register_request_rejects_blank_username_after_stripping() -> None:
    with pytest.raises(ValidationError):
        RegisterRequest(
            username="   ",
            email="alice@example.com",
            password="correct-password",
        )


def test_login_request_rejects_blank_identifier_after_stripping() -> None:
    with pytest.raises(ValidationError):
        LoginRequest(identifier="   ", password="correct-password")


@pytest.mark.parametrize(
    "token",
    ["", "   ", "a" * 42, "a" * 44, "a" * 42 + "!"],
)
def test_verify_email_request_rejects_invalid_token_format(token: str) -> None:
    with pytest.raises(ValidationError):
        VerifyEmailRequest(token=token)


def test_verify_email_request_accepts_43_character_urlsafe_token() -> None:
    request = VerifyEmailRequest(token="Abc_123-" + "x" * 35)

    assert len(request.token) == 43
