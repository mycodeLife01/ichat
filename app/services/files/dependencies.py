from functools import lru_cache
from typing import Literal

import boto3
from botocore.config import Config

from app.core.config import Settings, get_settings
from app.services.files.storage import R2FileStorage

CredentialRole = Literal["upload", "worker", "download", "preview_api", "preview_llm"]


def _credentials(settings: Settings, role: CredentialRole) -> tuple[str, str]:
    if role == "upload":
        return settings.files_upload_access_key_id, settings.files_upload_secret_access_key
    if role == "worker":
        return settings.files_worker_access_key_id, settings.files_worker_secret_access_key
    if role == "download":
        return settings.files_download_access_key_id, settings.files_download_secret_access_key
    if role == "preview_api":
        return (
            getattr(settings, "files_preview_api_access_key_id", ""),
            getattr(settings, "files_preview_api_secret_access_key", ""),
        )
    return (
        getattr(settings, "files_preview_llm_access_key_id", ""),
        getattr(settings, "files_preview_llm_secret_access_key", ""),
    )


def build_file_storage(settings: Settings, *, role: CredentialRole) -> R2FileStorage:
    access_key, secret_key = _credentials(settings, role)
    client = boto3.client(
        "s3",
        endpoint_url=settings.files_r2_endpoint_url or "https://disabled.invalid",
        region_name=settings.files_r2_region,
        aws_access_key_id=access_key or "disabled",
        aws_secret_access_key=secret_key or "disabled",
        config=Config(
            signature_version="s3v4",
            connect_timeout=settings.files_r2_connect_timeout_seconds,
            read_timeout=settings.files_r2_read_timeout_seconds,
            tcp_keepalive=True,
            retries={
                "max_attempts": settings.files_r2_max_attempts,
                "mode": "standard",
            },
        ),
    )
    return R2FileStorage(
        client,
        staging_bucket=settings.files_staging_bucket or "disabled",
        canonical_bucket=settings.files_canonical_bucket or "disabled",
        preview_bucket=getattr(settings, "files_preview_bucket", "") or "disabled",
        credential_role=role,
    )


@lru_cache
def get_file_upload_storage() -> R2FileStorage:
    return build_file_storage(get_settings(), role="upload")


@lru_cache
def get_file_worker_storage() -> R2FileStorage:
    return build_file_storage(get_settings(), role="worker")


@lru_cache
def get_file_download_storage() -> R2FileStorage:
    return build_file_storage(get_settings(), role="download")


@lru_cache
def get_file_preview_api_storage() -> R2FileStorage:
    return build_file_storage(get_settings(), role="preview_api")


@lru_cache
def get_file_preview_llm_storage() -> R2FileStorage:
    return build_file_storage(get_settings(), role="preview_llm")
