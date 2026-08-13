from pathlib import Path


def test_compose_uses_explicit_env_file() -> None:
    compose = Path("compose.yml").read_text()

    # Infrastructure, migrations, and file parsing use explicit least-
    # privilege environments instead of receiving every application secret.
    assert compose.count("\n    env_file:\n") == 5
    assert compose.count("- .env") == 5
    postgres = compose.split("  postgres:", 1)[1].split("  redis:", 1)[0]
    migrate = compose.split("  migrate:", 1)[1].split("  api:", 1)[0]
    file_worker = compose.split("  file-worker:", 1)[1].split("  celery-beat:", 1)[0]
    assert "\n    env_file:\n" not in postgres
    assert "\n    env_file:\n" not in migrate
    assert "\n    env_file:\n" not in file_worker
    assert "POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}" in postgres
    assert "DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}" in migrate


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


def test_compose_isolates_preview_credentials_by_process_role() -> None:
    for filename in ("compose.yml", "compose.prod.yml"):
        compose = Path(filename).read_text()
        api = compose.split("  api:", 1)[1].split("  worker:", 1)[0]
        postgres = compose.split("  postgres:", 1)[1].split("  redis:", 1)[0]
        migrate = compose.split("  migrate:", 1)[1].split("  api:", 1)[0]
        worker = compose.split("  worker:", 1)[1].split("  celery-worker:", 1)[0]
        file_worker = compose.split("  file-worker:", 1)[1].split("  celery-beat:", 1)[0]

        assert 'FILES_WORKER_ACCESS_KEY_ID: ""' in api
        assert 'FILES_PREVIEW_LLM_ACCESS_KEY_ID: ""' in api
        assert "FILES_PREVIEW_API_ACCESS_KEY_ID" not in api

        assert 'FILES_STAGING_BUCKET: ""' in worker
        assert 'FILES_CANONICAL_BUCKET: ""' in worker
        assert 'FILES_UPLOAD_ACCESS_KEY_ID: ""' in worker
        assert 'FILES_WORKER_ACCESS_KEY_ID: ""' in worker
        assert 'FILES_DOWNLOAD_ACCESS_KEY_ID: ""' in worker
        assert 'FILES_PREVIEW_API_ACCESS_KEY_ID: ""' in worker
        assert 'FILES_PREVIEW_LLM_ACCESS_KEY_ID: ""' not in worker

        assert "FILES_PREVIEW_BUCKET: ${FILES_PREVIEW_BUCKET:-}" in file_worker
        assert "FILES_WORKER_ACCESS_KEY_ID: ${FILES_WORKER_ACCESS_KEY_ID:-}" in file_worker
        assert "FILES_PREVIEW_API_ACCESS_KEY_ID" not in file_worker
        assert "FILES_PREVIEW_LLM_ACCESS_KEY_ID" not in file_worker

        for service in (postgres, migrate):
            assert "env_file:" not in service
            assert "OPENAI_API_KEY" not in service
            assert "DEEPSEEK_API_KEY" not in service
            assert "FILES_" not in service


def test_clamav_startup_and_healthcheck_are_signature_aware() -> None:
    entrypoint_path = "./deploy/clamav/entrypoint.sh:/usr/local/bin/ichat-clamav-entrypoint.sh:ro"
    healthcheck_path = (
        "./deploy/clamav/healthcheck.sh:/usr/local/bin/ichat-clamav-healthcheck.sh:ro"
    )

    for filename in ("compose.yml", "compose.prod.yml"):
        compose = Path(filename).read_text()
        clamav = compose.split("  clamav:", 1)[1].split("  file-worker:", 1)[0]

        assert entrypoint_path in clamav
        assert healthcheck_path in clamav
        assert 'entrypoint: ["/bin/sh", "/usr/local/bin/ichat-clamav-entrypoint.sh"]' in clamav
        assert (
            "CLAMAV_SIGNATURE_MAX_AGE_SECONDS: "
            "${CLAMAV_SIGNATURE_MAX_AGE_SECONDS:-172800}"
        ) in clamav
        assert 'test: ["CMD", "/bin/sh", "/usr/local/bin/ichat-clamav-healthcheck.sh"]' in clamav

    entrypoint = Path("deploy/clamav/entrypoint.sh").read_text()
    healthcheck = Path("deploy/clamav/healthcheck.sh").read_text()
    assert "freshclam --foreground --stdout" in entrypoint
    assert "exec /init" in entrypoint
    assert "zVERSION" in healthcheck
    assert "freshclam --version" in healthcheck
    assert "CLAMAV_SIGNATURE_MAX_AGE_SECONDS" in healthcheck
