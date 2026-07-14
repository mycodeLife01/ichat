from datetime import datetime

from pydantic import BaseModel, Field

from app.models.avatar import AvatarUploadStatus


class CreateAvatarUploadRequest(BaseModel):
    size_bytes: int = Field(gt=0, le=2 * 1024 * 1024)


class CreateAvatarUploadResponse(BaseModel):
    upload_id: str
    upload_url: str
    upload_headers: dict[str, str]
    upload_url_expires_at: datetime
    session_expires_at: datetime


class ConfirmAvatarUploadRequest(BaseModel):
    etag: str = Field(min_length=1, max_length=255)


class AvatarUploadResponse(BaseModel):
    upload_id: str
    status: AvatarUploadStatus
    error_code: str | None = None
    message: str | None = None
    avatar_url: str | None = None
