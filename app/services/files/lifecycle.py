from __future__ import annotations

from datetime import datetime, timedelta

from app.models.files import FileUpload, FileUploadStatus

ACTIVE_UPLOAD_STATUSES = frozenset(
    {
        FileUploadStatus.PENDING,
        FileUploadStatus.QUEUED,
        FileUploadStatus.PROCESSING,
    }
)
TERMINAL_UPLOAD_STATUSES = frozenset(
    {
        FileUploadStatus.SUCCEEDED,
        FileUploadStatus.REJECTED,
        FileUploadStatus.FAILED,
        FileUploadStatus.EXPIRED,
        FileUploadStatus.CANCELLED,
    }
)

_ALLOWED_TRANSITIONS: dict[FileUploadStatus, frozenset[FileUploadStatus]] = {
    FileUploadStatus.PENDING: frozenset(
        {FileUploadStatus.QUEUED, FileUploadStatus.EXPIRED, FileUploadStatus.CANCELLED}
    ),
    FileUploadStatus.QUEUED: frozenset(
        {FileUploadStatus.PROCESSING, FileUploadStatus.CANCELLED, FileUploadStatus.FAILED}
    ),
    FileUploadStatus.PROCESSING: frozenset(
        {
            FileUploadStatus.QUEUED,
            FileUploadStatus.SUCCEEDED,
            FileUploadStatus.REJECTED,
            FileUploadStatus.FAILED,
            FileUploadStatus.CANCELLED,
        }
    ),
    FileUploadStatus.SUCCEEDED: frozenset(),
    FileUploadStatus.REJECTED: frozenset(),
    FileUploadStatus.FAILED: frozenset(),
    FileUploadStatus.EXPIRED: frozenset(),
    FileUploadStatus.CANCELLED: frozenset(),
}


def transition_upload(
    upload: FileUpload,
    target: FileUploadStatus,
    *,
    now: datetime,
    error_code: str | None = None,
) -> None:
    """Apply one validated upload transition.

    This small rule is shared by API, worker and maintenance paths. Terminal
    states never re-enter the state machine; an idempotent caller should check
    the current state before asking for a transition.
    """

    current = FileUploadStatus(upload.status)
    if target not in _ALLOWED_TRANSITIONS[current]:
        raise ValueError(f"Invalid file upload transition: {current.value} -> {target.value}")
    upload.status = target
    upload.error_code = error_code
    if target == FileUploadStatus.QUEUED:
        upload.queued_at = now
        upload.available_at = now
        upload.lease_owner = None
        upload.lease_expires_at = None
    elif target == FileUploadStatus.PROCESSING:
        upload.claimed_at = now
    elif target in TERMINAL_UPLOAD_STATUSES:
        upload.completed_at = now
        upload.lease_owner = None
        upload.lease_expires_at = None


def retry_available_at(*, attempt_count: int, now: datetime) -> datetime:
    """Three attempts total: retry after 30 seconds, then after five minutes."""

    delay_seconds = 30 if attempt_count <= 1 else 300
    return now + timedelta(seconds=delay_seconds)
