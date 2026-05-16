import pytest
from pydantic import ValidationError

from app.schemas.auth import LoginRequest, RegisterRequest


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
