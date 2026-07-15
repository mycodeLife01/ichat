from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Protocol
from urllib.parse import quote
from uuid import uuid4

import boto3
import httpx
from botocore.config import Config

from app.core.config import Settings

AVATAR_CONTENT_TYPE = "image/webp"
AVATAR_CACHE_CONTROL = "public, max-age=31536000, immutable"

# Browsers without canvas WebP encoding (Safari) upload PNG/JPEG sources;
# the worker always re-encodes the published avatar as WebP.
ALLOWED_UPLOAD_CONTENT_TYPES = frozenset({"image/webp", "image/png", "image/jpeg"})
_UPLOAD_EXTENSIONS = {"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg"}


@dataclass(frozen=True)
class PresignedUpload:
    url: str
    headers: dict[str, str]


@dataclass(frozen=True)
class ObjectMetadata:
    size_bytes: int
    content_type: str
    etag: str
    declared_size_bytes: int | None = None


class AvatarStorage(Protocol):
    def presign_upload(
        self, object_key: str, *, size_bytes: int, ttl_seconds: int, content_type: str
    ) -> PresignedUpload: ...

    def head_temporary(self, object_key: str) -> ObjectMetadata: ...

    def get_temporary(self, object_key: str) -> bytes: ...

    def delete_temporary(self, object_key: str) -> None: ...

    def put_public(self, object_key: str, content: bytes) -> None: ...

    def delete_public(self, object_key: str) -> None: ...


class AvatarTaskPublisher(Protocol):
    def publish(self, upload_id: str) -> None: ...


class CdnPurger(Protocol):
    def purge(self, url: str) -> None: ...


def temporary_object_key(content_type: str = AVATAR_CONTENT_TYPE) -> str:
    return f"avatar-uploads/{uuid4()}.{_UPLOAD_EXTENSIONS[content_type]}"


def public_object_key() -> str:
    return f"avatars/{uuid4()}.webp"


def public_avatar_url(settings: Settings, object_key: str | None) -> str | None:
    if object_key is None or not settings.avatar_public_base_url.strip():
        return None
    base = settings.avatar_public_base_url.rstrip("/")
    return f"{base}/{quote(object_key, safe='/')}"


def _s3_client(settings: Settings, *, worker: bool) -> object:
    access_key = (
        settings.avatar_worker_access_key_id if worker else settings.avatar_api_access_key_id
    )
    secret_key = (
        settings.avatar_worker_secret_access_key
        if worker
        else settings.avatar_api_secret_access_key
    )
    return boto3.client(
        "s3",
        endpoint_url=settings.avatar_r2_endpoint_url,
        region_name=settings.avatar_r2_region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
    )


class R2AvatarStorage:
    def __init__(self, settings: Settings, *, worker: bool) -> None:
        self._settings = settings
        self._client = _s3_client(settings, worker=worker)

    def presign_upload(
        self, object_key: str, *, size_bytes: int, ttl_seconds: int, content_type: str
    ) -> PresignedUpload:
        params = {
            "Bucket": self._settings.avatar_upload_bucket,
            "Key": object_key,
            "ContentType": content_type,
            "Metadata": {"declared-size": str(size_bytes)},
        }
        url = self._client.generate_presigned_url(  # type: ignore[attr-defined]
            "put_object", Params=params, ExpiresIn=ttl_seconds, HttpMethod="PUT"
        )
        return PresignedUpload(
            url=url,
            headers={
                "Content-Type": content_type,
                "x-amz-meta-declared-size": str(size_bytes),
            },
        )

    def head_temporary(self, object_key: str) -> ObjectMetadata:
        response = self._client.head_object(  # type: ignore[attr-defined]
            Bucket=self._settings.avatar_upload_bucket, Key=object_key
        )
        declared_size = (response.get("Metadata") or {}).get("declared-size")
        return ObjectMetadata(
            size_bytes=int(response["ContentLength"]),
            content_type=str(response.get("ContentType") or ""),
            etag=str(response.get("ETag") or "").strip('"'),
            declared_size_bytes=int(declared_size) if declared_size is not None else None,
        )

    def get_temporary(self, object_key: str) -> bytes:
        response = self._client.get_object(  # type: ignore[attr-defined]
            Bucket=self._settings.avatar_upload_bucket, Key=object_key
        )
        return bytes(response["Body"].read())

    def delete_temporary(self, object_key: str) -> None:
        self._client.delete_object(  # type: ignore[attr-defined]
            Bucket=self._settings.avatar_upload_bucket, Key=object_key
        )

    def put_public(self, object_key: str, content: bytes) -> None:
        self._client.put_object(  # type: ignore[attr-defined]
            Bucket=self._settings.avatar_public_bucket,
            Key=object_key,
            Body=BytesIO(content),
            ContentType=AVATAR_CONTENT_TYPE,
            CacheControl=AVATAR_CACHE_CONTROL,
            Metadata={"x-content-type-options": "nosniff"},
        )

    def delete_public(self, object_key: str) -> None:
        self._client.delete_object(  # type: ignore[attr-defined]
            Bucket=self._settings.avatar_public_bucket, Key=object_key
        )


class CloudflareCdnPurger:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def purge(self, url: str) -> None:
        response = httpx.post(
            f"https://api.cloudflare.com/client/v4/zones/{self._settings.cloudflare_zone_id}/purge_cache",
            headers={
                "Authorization": f"Bearer {self._settings.cloudflare_purge_token}",
                "Content-Type": "application/json",
            },
            json={"files": [url]},
            timeout=10.0,
        )
        response.raise_for_status()
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError("Cloudflare cache purge failed")


class FakeAvatarStorage:
    def __init__(self) -> None:
        self.temporary: dict[str, tuple[bytes, str, str]] = {}
        self.public: dict[str, bytes] = {}

    def presign_upload(
        self, object_key: str, *, size_bytes: int, ttl_seconds: int, content_type: str
    ) -> PresignedUpload:
        return PresignedUpload(
            url=f"https://upload.invalid/{object_key}?ttl={ttl_seconds}",
            headers={
                "Content-Type": content_type,
                "x-amz-meta-declared-size": str(size_bytes),
            },
        )

    def head_temporary(self, object_key: str) -> ObjectMetadata:
        content, content_type, etag = self.temporary[object_key]
        return ObjectMetadata(len(content), content_type, etag)

    def get_temporary(self, object_key: str) -> bytes:
        return self.temporary[object_key][0]

    def delete_temporary(self, object_key: str) -> None:
        self.temporary.pop(object_key, None)

    def put_public(self, object_key: str, content: bytes) -> None:
        self.public[object_key] = content

    def delete_public(self, object_key: str) -> None:
        self.public.pop(object_key, None)


class FakeAvatarTaskPublisher:
    def __init__(self) -> None:
        self.upload_ids: list[str] = []

    def publish(self, upload_id: str) -> None:
        self.upload_ids.append(upload_id)


class FakeCdnPurger:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def purge(self, url: str) -> None:
        self.urls.append(url)
