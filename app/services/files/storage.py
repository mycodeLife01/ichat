"""Private object-storage adapters for the files service.

This module intentionally knows only the two private storage locations.  It
does not decide whether a user may upload or download an object; that remains a
domain-service authorization decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import md5
from io import BytesIO
from pathlib import PurePath
from typing import Any, Literal
from unicodedata import normalize
from urllib.parse import quote
from uuid import uuid4

from app.services.files.protocols import (
    DerivativeRole,
    ObjectDisposition,
    PresignedDownload,
    PresignedUpload,
    StorageObjectMetadata,
)


class StorageObjectMissing(Exception):
    """A content-free signal that an expected private object is absent."""


class StoragePreconditionFailed(Exception):
    """A content-free signal that a staging ETag no longer matches."""


class StoragePermissionDenied(Exception):
    """Raised when a credential-scoped adapter is used outside its capability."""


def staging_object_key(extension: str) -> str:
    """Generate an identity-free, single-upload staging key."""

    suffix = _safe_extension(extension)
    return f"file-staging/{uuid4()}.{suffix}"


def canonical_object_key(role: DerivativeRole, extension: str) -> str:
    """Generate an identity-free canonical key for one immutable derivative."""

    suffix = _safe_extension(extension)
    return f"files/{uuid4()}/{role}.{suffix}"


def _safe_extension(extension: str) -> str:
    normalized = extension.removeprefix(".").casefold()
    allowed = "abcdefghijklmnopqrstuvwxyz0123456789"
    if not normalized or any(char not in allowed for char in normalized):
        raise ValueError("invalid object extension")
    return normalized


def safe_content_disposition(disposition: ObjectDisposition, filename: str) -> str:
    """Build a CRLF-safe RFC 5987 disposition header value.

    The service supplies a stored, already-bounded original filename.  This
    final defensive normalization makes the storage adapter safe even when a
    future caller forgets to sanitize a response filename.
    """

    basename = PurePath(filename.replace("\\", "/")).name
    normalized_name = normalize("NFC", basename).replace("\r", "").replace("\n", "")
    normalized_name = normalized_name.replace('"', "").replace("\\", "")[:255]
    if not normalized_name:
        normalized_name = "download"
    ascii_name = "".join(char if 32 <= ord(char) < 127 else "_" for char in normalized_name)
    ascii_name = ascii_name.replace(";", "_") or "download"
    encoded_name = quote(normalized_name, safe="")
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"


class S3FileStorage:
    """S3-compatible private staging/canonical adapter (including Cloudflare R2)."""

    def __init__(self, client: Any, *, staging_bucket: str, canonical_bucket: str) -> None:
        self._client = client
        self._staging_bucket = staging_bucket
        self._canonical_bucket = canonical_bucket

    def presign_upload(
        self,
        object_key: str,
        *,
        size_bytes: int,
        ttl_seconds: int,
        content_type: str,
    ) -> PresignedUpload:
        params = {
            "Bucket": self._staging_bucket,
            "Key": object_key,
            "ContentType": content_type,
            "Metadata": {"declared-size": str(size_bytes)},
        }
        url = self._client.generate_presigned_url(
            "put_object",
            Params=params,
            ExpiresIn=ttl_seconds,
            HttpMethod="PUT",
        )
        return PresignedUpload(
            url=str(url),
            headers={
                "Content-Type": content_type,
                "x-amz-meta-declared-size": str(size_bytes),
            },
        )

    def head_staging(self, object_key: str) -> StorageObjectMetadata:
        response = self._client.head_object(Bucket=self._staging_bucket, Key=object_key)
        declared_size = (response.get("Metadata") or {}).get("declared-size")
        return StorageObjectMetadata(
            size_bytes=int(response["ContentLength"]),
            content_type=str(response.get("ContentType") or ""),
            etag=str(response.get("ETag") or "").strip('"'),
            declared_size_bytes=int(declared_size) if declared_size is not None else None,
        )

    def get_staging(self, object_key: str, *, if_match: str) -> bytes:
        response = self._client.get_object(
            Bucket=self._staging_bucket,
            Key=object_key,
            IfMatch=_quoted_etag(if_match),
        )
        return bytes(response["Body"].read())

    def delete_staging(self, object_key: str) -> None:
        self._client.delete_object(Bucket=self._staging_bucket, Key=object_key)

    def put_canonical(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self._client.put_object(
            Bucket=self._canonical_bucket,
            Key=object_key,
            Body=BytesIO(content),
            ContentType=content_type,
            Metadata={"x-content-type-options": "nosniff"},
        )

    def delete_canonical(self, object_key: str) -> None:
        self._client.delete_object(Bucket=self._canonical_bucket, Key=object_key)

    def presign_download(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        disposition: ObjectDisposition,
        filename: str,
    ) -> PresignedDownload:
        response_disposition = safe_content_disposition(disposition, filename)
        url = self._client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self._canonical_bucket,
                "Key": object_key,
                "ResponseContentDisposition": response_disposition,
            },
            ExpiresIn=ttl_seconds,
            HttpMethod="GET",
        )
        return PresignedDownload(url=str(url))


StorageCredentialRole = Literal["upload", "worker", "download"]


class R2FileStorage(S3FileStorage):
    """R2 adapter with an explicit least-privilege credential role.

    Settings and client construction intentionally live in a composition root,
    not in this adapter.  This keeps untrusted file-processing imports free of
    application configuration while making API/worker credential separation
    testable at the narrow storage seam.
    """

    def __init__(
        self,
        client: Any,
        *,
        staging_bucket: str,
        canonical_bucket: str,
        credential_role: StorageCredentialRole,
    ) -> None:
        super().__init__(client, staging_bucket=staging_bucket, canonical_bucket=canonical_bucket)
        self._credential_role = credential_role

    def presign_upload(
        self,
        object_key: str,
        *,
        size_bytes: int,
        ttl_seconds: int,
        content_type: str,
    ) -> PresignedUpload:
        self._require("upload")
        return super().presign_upload(
            object_key,
            size_bytes=size_bytes,
            ttl_seconds=ttl_seconds,
            content_type=content_type,
        )

    def head_staging(self, object_key: str) -> StorageObjectMetadata:
        self._require("upload", "worker")
        return super().head_staging(object_key)

    def get_staging(self, object_key: str, *, if_match: str) -> bytes:
        self._require("worker")
        return super().get_staging(object_key, if_match=if_match)

    def delete_staging(self, object_key: str) -> None:
        self._require("worker")
        super().delete_staging(object_key)

    def put_canonical(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self._require("worker")
        super().put_canonical(object_key, content=content, content_type=content_type)

    def delete_canonical(self, object_key: str) -> None:
        self._require("worker")
        super().delete_canonical(object_key)

    def presign_download(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        disposition: ObjectDisposition,
        filename: str,
    ) -> PresignedDownload:
        self._require("download")
        return super().presign_download(
            object_key,
            ttl_seconds=ttl_seconds,
            disposition=disposition,
            filename=filename,
        )

    def _require(self, *roles: StorageCredentialRole) -> None:
        if self._credential_role not in roles:
            raise StoragePermissionDenied


def _quoted_etag(etag: str) -> str:
    return etag if etag.startswith('"') and etag.endswith('"') else f'"{etag}"'


@dataclass(frozen=True)
class _FakeObject:
    content: bytes
    content_type: str
    etag: str
    declared_size_bytes: int | None = None


class FakeFileStorage:
    """In-memory storage seam used by tests without R2 or signed URLs."""

    def __init__(self) -> None:
        self.staging: dict[str, _FakeObject] = {}
        self.canonical: dict[str, _FakeObject] = {}
        self.deleted_staging: list[str] = []
        self.deleted_canonical: list[str] = []

    def put_staging(
        self,
        object_key: str,
        content: bytes,
        *,
        content_type: str,
        declared_size_bytes: int | None = None,
    ) -> str:
        """Test helper emulating a browser's staging PUT."""

        etag = md5(content, usedforsecurity=False).hexdigest()
        self.staging[object_key] = _FakeObject(
            content=content,
            content_type=content_type,
            etag=etag,
            declared_size_bytes=declared_size_bytes,
        )
        return etag

    upload_staging = put_staging

    def presign_upload(
        self,
        object_key: str,
        *,
        size_bytes: int,
        ttl_seconds: int,
        content_type: str,
    ) -> PresignedUpload:
        return PresignedUpload(
            url=f"https://upload.invalid/{quote(object_key, safe='/')}?ttl={ttl_seconds}",
            headers={
                "Content-Type": content_type,
                "x-amz-meta-declared-size": str(size_bytes),
            },
        )

    def head_staging(self, object_key: str) -> StorageObjectMetadata:
        item = self._staging_object(object_key)
        return StorageObjectMetadata(
            size_bytes=len(item.content),
            content_type=item.content_type,
            etag=item.etag,
            declared_size_bytes=item.declared_size_bytes,
        )

    def get_staging(self, object_key: str, *, if_match: str) -> bytes:
        item = self._staging_object(object_key)
        if item.etag != if_match.strip('"'):
            raise StoragePreconditionFailed
        return item.content

    def delete_staging(self, object_key: str) -> None:
        self.staging.pop(object_key, None)
        self.deleted_staging.append(object_key)

    def put_canonical(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self.canonical[object_key] = _FakeObject(
            content=content,
            content_type=content_type,
            etag=md5(content, usedforsecurity=False).hexdigest(),
        )

    def delete_canonical(self, object_key: str) -> None:
        self.canonical.pop(object_key, None)
        self.deleted_canonical.append(object_key)

    def presign_download(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        disposition: ObjectDisposition,
        filename: str,
    ) -> PresignedDownload:
        if object_key not in self.canonical:
            raise StorageObjectMissing
        return PresignedDownload(
            url=f"https://download.invalid/{quote(object_key, safe='/')}?ttl={ttl_seconds}",
            headers={"Content-Disposition": safe_content_disposition(disposition, filename)},
        )

    def _staging_object(self, object_key: str) -> _FakeObject:
        try:
            return self.staging[object_key]
        except KeyError:
            raise StorageObjectMissing from None
