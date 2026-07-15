from typing import Any

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    nickname: str | None = Field(default=None, min_length=1, max_length=50)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username", "nickname", mode="before")
    @classmethod
    def normalize_names(cls, value: Any) -> Any:
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
    token: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$")


class RequestPasswordResetRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$")
    new_password: str = Field(min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class RequestAccountDeletionRequest(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class ConfirmAccountDeletionRequest(BaseModel):
    token: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]{43}$")


class UpdateProfileRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=50)

    @field_validator("nickname", mode="before")
    @classmethod
    def normalize_nickname(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value


class AuthUserResponse(BaseModel):
    id: int
    username: str
    nickname: str
    email: str
    email_verified: bool
    avatar_url: str | None = None


class AuthTokenResponse(BaseModel):
    user: AuthUserResponse
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class CommandStatusResponse(BaseModel):
    status: str = "ok"
