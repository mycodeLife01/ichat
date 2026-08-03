from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

FileCategory = Literal["image", "pdf", "office", "text"]
FileModelInputKindValue = Literal["document", "image"]
FileUploadStatusValue = Literal[
    "pending",
    "queued",
    "processing",
    "succeeded",
    "rejected",
    "failed",
    "expired",
    "cancelled",
]


class CreateFileUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=127)
    size_bytes: int = Field(gt=0, le=50 * 1024 * 1024)


class CreateFileUploadResponse(BaseModel):
    upload_id: UUID
    status: FileUploadStatusValue
    upload_url: str
    upload_headers: dict[str, str]
    upload_url_expires_at: datetime
    session_expires_at: datetime


class ConfirmFileUploadRequest(BaseModel):
    etag: str = Field(min_length=1, max_length=255)


class FileAssetResponse(BaseModel):
    id: UUID
    name: str
    media_type: str
    size_bytes: int
    category: FileCategory
    model_input_kind: FileModelInputKindValue | None = None
    warnings: list[str] = Field(default_factory=list)
    preview_available: bool = False
    unbound_expires_at: datetime | None = None
    stats: dict[str, int | str] = Field(default_factory=dict)


class FileUploadResponse(BaseModel):
    upload_id: UUID
    status: FileUploadStatusValue
    error_code: str | None = None
    message: str | None = None
    file: FileAssetResponse | None = None


class FileUploadStatusRequest(BaseModel):
    upload_ids: list[UUID] = Field(min_length=1, max_length=100)

    @field_validator("upload_ids")
    @classmethod
    def reject_duplicate_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(value) != len(set(value)):
            raise ValueError("Upload IDs must be unique")
        return value


class CancelFileUploadsRequest(FileUploadStatusRequest):
    """Cancel a draft upload set atomically."""


class FileReadUrlRequest(BaseModel):
    role: Literal["preview", "download"]


class FileReadUrlResponse(BaseModel):
    url: str
    expires_at: datetime


class MessageAttachmentResponse(BaseModel):
    id: UUID
    name: str
    media_type: str
    size_bytes: int
    category: FileCategory
    model_input_kind: FileModelInputKindValue | None = None
    warnings: list[str] = Field(default_factory=list)
    preview_available: bool = False
    position: int


class SharedAttachmentResponse(BaseModel):
    """Non-sensitive attachment placeholder embedded in a public snapshot."""

    name: str
    media_type: str
    size_bytes: int
    category: FileCategory
    warnings: list[str] = Field(default_factory=list)
