from pydantic import BaseModel

from app.schemas.responses import ResponseMeta, SuccessResponse


class AuthUserResponse(BaseModel):
    id: int
    username: str
    email: str
    email_verified: bool


class AuthTokenResponse(BaseModel):
    user: AuthUserResponse
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int


def test_success_response_wraps_auth_token_response_in_data() -> None:
    response = SuccessResponse[AuthTokenResponse](
        data=AuthTokenResponse(
            user=AuthUserResponse(
                id=1,
                username="alice",
                email="alice@example.com",
                email_verified=False,
            ),
            access_token="access-token",
            refresh_token="refresh-token",
            token_type="bearer",
            expires_in=900,
        )
    )

    assert response.model_dump(exclude_none=True) == {
        "data": {
            "user": {
                "id": 1,
                "username": "alice",
                "email": "alice@example.com",
                "email_verified": False,
            },
            "access_token": "access-token",
            "refresh_token": "refresh-token",
            "token_type": "bearer",
            "expires_in": 900,
        }
    }


def test_success_response_includes_meta_when_provided() -> None:
    response = SuccessResponse[list[dict[str, int]]](
        data=[{"id": 1}],
        meta=ResponseMeta.model_validate({"total": 1}),
    )

    assert response.model_dump(exclude_none=True) == {
        "data": [{"id": 1}],
        "meta": {"total": 1},
    }
