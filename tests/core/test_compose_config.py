from pathlib import Path


def test_compose_uses_explicit_env_file() -> None:
    compose = Path("compose.yml").read_text()

    # File parsing is intentionally the only application process without the
    # shared env file, so it cannot receive unrelated application secrets.
    assert compose.count("\n    env_file:\n") == 7
    assert compose.count("- .env") == 7
    file_worker = compose.split("  file-worker:", 1)[1].split("  celery-beat:", 1)[0]
    assert "\n    env_file:\n" not in file_worker


def test_compose_requires_referenced_environment_variables() -> None:
    compose = Path("compose.yml").read_text()

    assert "${API_PORT:?API_PORT is required}" in compose
    assert "${POSTGRES_PORT:?POSTGRES_PORT is required}" in compose
    file_worker = compose.split("  file-worker:", 1)[1].split("  celery-beat:", 1)[0]
    assert "DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}" in file_worker
    assert "CELERY_BROKER_URL: ${CELERY_BROKER_URL:?CELERY_BROKER_URL is required}" in file_worker
    assert "FILES_WORKER_ACCESS_KEY_ID: ${FILES_WORKER_ACCESS_KEY_ID:-}" in file_worker
    assert "FILES_WORKER_SECRET_ACCESS_KEY: ${FILES_WORKER_SECRET_ACCESS_KEY:-}" in file_worker
    assert "FILES_UPLOAD_ACCESS_KEY_ID" not in file_worker
    assert "FILES_DOWNLOAD_ACCESS_KEY_ID" not in file_worker
    assert "SMTP_" not in file_worker
