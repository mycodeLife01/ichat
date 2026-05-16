from fastapi import status

from app.core.errors import AppError


def test_app_error_keeps_status_code_and_detail() -> None:
    error = AppError(status.HTTP_404_NOT_FOUND, "Conversation not found")

    assert error.status_code == status.HTTP_404_NOT_FOUND
    assert error.detail == "Conversation not found"
