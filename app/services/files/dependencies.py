from functools import lru_cache
from typing import Literal

import boto3
from botocore.config import Config

from app.core.config import Settings, get_settings
from app.services.files.storage import R2FileStorage

CredentialRole = Literal["upload", "worker", "download"]


def _credentials(settings: Settings, role: CredentialRole) -> tuple[str, str]:
    if role == "upload":
        return settings.files_upload_access_key_id, settings.files_upload_secret_access_key
    if role == "worker":
        return settings.files_worker_access_key_id, settings.files_worker_secret_access_key
    return settings.files_download_access_key_id, settings.files_download_secret_access_key


def build_file_storage(settings: Settings, *, role: CredentialRole) -> R2FileStorage:
    access_key, secret_key = _credentials(settings, role)
    client = boto3.client(
        "s3",
        endpoint_url=settings.files_r2_endpoint_url or "https://disabled.invalid",
        region_name=settings.files_r2_region,
        aws_access_key_id=access_key or "disabled",
        aws_secret_access_key=secret_key or "disabled",
        config=Config(signature_version="s3v4"),
    )
    return R2FileStorage(
        client,
        staging_bucket=settings.files_staging_bucket or "disabled",
        canonical_bucket=settings.files_canonical_bucket or "disabled",
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
