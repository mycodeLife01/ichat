from typing import Any

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value


class LoginRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("identifier", mode="before")
    @classmethod
    def normalize_identifier(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value


class RefreshTokenRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=1)


class AuthUserResponse(BaseModel):
    id: int
    username: str
    email: str
    email_verified: bool


class AuthTokenResponse(BaseModel):
    user: AuthUserResponse
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class CommandStatusResponse(BaseModel):
    status: str = "ok"
