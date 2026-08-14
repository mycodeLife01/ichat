"""Celery file-task limits follow the public deployment configuration."""

from app.core.config import get_settings
from app.tasks.file_tasks import process_file_upload


def test_process_file_upload_uses_the_configured_attempt_timeout() -> None:
    configured = get_settings().files_attempt_timeout_seconds

    assert process_file_upload.time_limit == max(2, configured)
    assert process_file_upload.soft_time_limit == max(1, max(2, configured) - 5)
