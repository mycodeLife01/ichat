"""Private object-storage adapters for the files service.

This module intentionally knows only the private staging, canonical, and
model-preview storage locations.  It
does not decide whether a user may upload or download an object; that remains a
domain-service authorization decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import md5, sha256
from io import BytesIO
from pathlib import PurePath
from typing import Any, Literal
from unicodedata import normalize
from urllib.parse import quote
from uuid import uuid4

from app.models.files import FileStorageLocation
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


class StorageIntegrityError(Exception):
    """Raised when a copied object does not match its durable database fact."""


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

    def __init__(
        self,
        client: Any,
        *,
        staging_bucket: str,
        canonical_bucket: str,
        preview_bucket: str | None = None,
    ) -> None:
        self._client = client
        self._staging_bucket = staging_bucket
        self._canonical_bucket = canonical_bucket
        # Falling back to canonical keeps the adapter useful for migration
        # tooling and old fakes; production dependencies always pass a
        # distinct preview bucket.
        self._preview_bucket = preview_bucket or canonical_bucket

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
            Metadata={
                "x-content-type-options": "nosniff",
                "sha256": sha256(content).hexdigest(),
            },
        )

    def delete_canonical(self, object_key: str) -> None:
        self._client.delete_object(Bucket=self._canonical_bucket, Key=object_key)

    def put_preview(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self._client.put_object(
            Bucket=self._preview_bucket,
            Key=object_key,
            Body=BytesIO(content),
            ContentType=content_type,
            Metadata={
                "x-content-type-options": "nosniff",
                "sha256": sha256(content).hexdigest(),
            },
        )

    def delete_preview(self, object_key: str) -> None:
        self._client.delete_object(Bucket=self._preview_bucket, Key=object_key)

    def get_canonical(self, object_key: str) -> bytes:
        response = self._client.get_object(Bucket=self._canonical_bucket, Key=object_key)
        return bytes(response["Body"].read())

    def get_preview(self, object_key: str) -> bytes:
        response = self._client.get_object(Bucket=self._preview_bucket, Key=object_key)
        return bytes(response["Body"].read())

    def copy_canonical_to_preview(
        self,
        object_key: str,
        *,
        expected_size_bytes: int,
        expected_sha256: str,
        content_type: str,
    ) -> StorageObjectMetadata:
        try:
            existing = self.get_preview(object_key)
        except Exception as exc:
            # S3/R2 adapters expose provider-specific 404 exception classes;
            # preserve all non-missing failures while treating a missing
            # destination as the normal first-copy path.
            response = getattr(exc, "response", None)
            code = str((response or {}).get("Error", {}).get("Code", ""))
            if code not in {"404", "NoSuchKey", "NotFound"}:
                raise
            existing = None
        if existing is not None:
            existing_hash = sha256(existing).hexdigest()
            if len(existing) != expected_size_bytes or existing_hash != expected_sha256:
                raise StorageIntegrityError
            return StorageObjectMetadata(
                size_bytes=len(existing),
                content_type=content_type,
                etag=existing_hash,
                sha256=existing_hash,
            )
        content = self.get_canonical(object_key)
        actual_hash = sha256(content).hexdigest()
        if len(content) != expected_size_bytes or actual_hash != expected_sha256:
            raise StorageIntegrityError
        self.put_preview(object_key, content=content, content_type=content_type)
        return StorageObjectMetadata(
            size_bytes=len(content),
            content_type=content_type,
            etag=actual_hash,
            sha256=actual_hash,
        )

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

    def presign_preview(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        filename: str,
        storage_location: FileStorageLocation = FileStorageLocation.MODEL_PREVIEW_PRIVATE,
    ) -> PresignedDownload:
        response_disposition = safe_content_disposition("inline", filename)
        bucket = self._bucket_for_location(storage_location)
        url = self._client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": object_key,
                "ResponseContentDisposition": response_disposition,
            },
            ExpiresIn=ttl_seconds,
            HttpMethod="GET",
        )
        return PresignedDownload(url=str(url))

    def presign_model_preview(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
    ) -> PresignedDownload:
        url = self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._preview_bucket, "Key": object_key},
            ExpiresIn=ttl_seconds,
            HttpMethod="GET",
        )
        return PresignedDownload(url=str(url))

    def head_model_preview(self, object_key: str) -> StorageObjectMetadata:
        """Read safe preview metadata before issuing a model-facing URL."""

        try:
            response = self._client.head_object(Bucket=self._preview_bucket, Key=object_key)
        except Exception as exc:
            code = _storage_error_code(exc)
            if code in {"404", "NoSuchKey", "NotFound"}:
                raise StorageObjectMissing from None
            if code in {"401", "403", "AccessDenied", "Forbidden"}:
                raise StoragePermissionDenied from None
            raise
        metadata = response.get("Metadata") or {}
        return StorageObjectMetadata(
            size_bytes=int(response["ContentLength"]),
            content_type=str(response.get("ContentType") or ""),
            etag=str(response.get("ETag") or "").strip('"'),
            sha256=(str(metadata["sha256"]) if metadata.get("sha256") is not None else None),
        )

    def _bucket_for_location(self, location: FileStorageLocation) -> str:
        if location == FileStorageLocation.CANONICAL_PRIVATE:
            return self._canonical_bucket
        if location == FileStorageLocation.MODEL_PREVIEW_PRIVATE:
            return self._preview_bucket
        raise StoragePermissionDenied


StorageCredentialRole = Literal["upload", "worker", "download", "preview_api", "preview_llm"]


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
        preview_bucket: str | None = None,
        credential_role: StorageCredentialRole,
    ) -> None:
        super().__init__(
            client,
            staging_bucket=staging_bucket,
            canonical_bucket=canonical_bucket,
            preview_bucket=preview_bucket,
        )
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

    def get_canonical(self, object_key: str) -> bytes:
        self._require("worker")
        return super().get_canonical(object_key)

    def get_preview(self, object_key: str) -> bytes:
        self._require("worker")
        return super().get_preview(object_key)

    def put_preview(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self._require("worker")
        super().put_preview(object_key, content=content, content_type=content_type)

    def delete_preview(self, object_key: str) -> None:
        self._require("worker")
        super().delete_preview(object_key)

    def put_model_preview(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self.put_preview(object_key, content=content, content_type=content_type)

    def delete_model_preview(self, object_key: str) -> None:
        self.delete_preview(object_key)

    def copy_canonical_to_preview(
        self,
        object_key: str,
        *,
        expected_size_bytes: int,
        expected_sha256: str,
        content_type: str,
    ) -> StorageObjectMetadata:
        self._require("worker")
        return super().copy_canonical_to_preview(
            object_key,
            expected_size_bytes=expected_size_bytes,
            expected_sha256=expected_sha256,
            content_type=content_type,
        )

    def copy_canonical_to_model_preview(
        self,
        object_key: str,
        *,
        expected_size_bytes: int,
        expected_sha256: str,
        content_type: str,
    ) -> StorageObjectMetadata:
        return self.copy_canonical_to_preview(
            object_key,
            expected_size_bytes=expected_size_bytes,
            expected_sha256=expected_sha256,
            content_type=content_type,
        )

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

    def presign_preview(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        filename: str,
        storage_location: FileStorageLocation = FileStorageLocation.MODEL_PREVIEW_PRIVATE,
    ) -> PresignedDownload:
        if storage_location == FileStorageLocation.CANONICAL_PRIVATE:
            self._require("download")
        elif storage_location == FileStorageLocation.MODEL_PREVIEW_PRIVATE:
            self._require("preview_api")
        else:
            raise StoragePermissionDenied
        return super().presign_preview(
            object_key,
            ttl_seconds=ttl_seconds,
            filename=filename,
            storage_location=storage_location,
        )

    def presign_model_preview(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
    ) -> PresignedDownload:
        self._require("preview_llm")
        return super().presign_model_preview(object_key, ttl_seconds=ttl_seconds)

    def head_model_preview(self, object_key: str) -> StorageObjectMetadata:
        self._require("preview_llm")
        return super().head_model_preview(object_key)

    def _require(self, *roles: StorageCredentialRole) -> None:
        if self._credential_role not in roles:
            raise StoragePermissionDenied


def _quoted_etag(etag: str) -> str:
    return etag if etag.startswith('"') and etag.endswith('"') else f'"{etag}"'


def _storage_error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    return str((response or {}).get("Error", {}).get("Code", ""))


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
        self.model_preview: dict[str, _FakeObject] = {}
        # ``preview`` is a convenient spelling used by migration tests.
        self.preview = self.model_preview
        self.deleted_staging: list[str] = []
        self.deleted_canonical: list[str] = []
        self.deleted_preview: list[str] = []

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

    def put_preview(self, object_key: str, *, content: bytes, content_type: str) -> None:
        self.model_preview[object_key] = _FakeObject(
            content=content,
            content_type=content_type,
            etag=md5(content, usedforsecurity=False).hexdigest(),
        )

    def delete_preview(self, object_key: str) -> None:
        self.model_preview.pop(object_key, None)
        self.deleted_preview.append(object_key)

    put_model_preview = put_preview
    delete_model_preview = delete_preview

    def get_canonical(self, object_key: str) -> bytes:
        try:
            return self.canonical[object_key].content
        except KeyError:
            raise StorageObjectMissing from None

    def copy_canonical_to_preview(
        self,
        object_key: str,
        *,
        expected_size_bytes: int,
        expected_sha256: str,
        content_type: str,
    ) -> StorageObjectMetadata:
        try:
            existing = self.model_preview[object_key]
        except KeyError:
            existing = None
        if existing is not None:
            existing_hash = sha256(existing.content).hexdigest()
            if len(existing.content) != expected_size_bytes or existing_hash != expected_sha256:
                raise StorageIntegrityError
            return StorageObjectMetadata(
                size_bytes=len(existing.content),
                content_type=existing.content_type,
                etag=existing.etag,
                sha256=existing_hash,
            )

        content = self.get_canonical(object_key)
        actual_hash = sha256(content).hexdigest()
        if len(content) != expected_size_bytes or actual_hash != expected_sha256:
            raise StorageIntegrityError
        self.put_preview(object_key, content=content, content_type=content_type)
        return StorageObjectMetadata(
            size_bytes=len(content),
            content_type=content_type,
            etag=actual_hash,
            sha256=actual_hash,
        )

    copy_canonical_to_model_preview = copy_canonical_to_preview

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

    def presign_preview(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        filename: str,
        storage_location: FileStorageLocation = FileStorageLocation.MODEL_PREVIEW_PRIVATE,
    ) -> PresignedDownload:
        objects = (
            self.canonical
            if storage_location == FileStorageLocation.CANONICAL_PRIVATE
            else self.model_preview
        )
        if object_key not in objects:
            raise StorageObjectMissing
        return PresignedDownload(
            url=f"https://preview.invalid/{quote(object_key, safe='/')}?ttl={ttl_seconds}",
            headers={"Content-Disposition": safe_content_disposition("inline", filename)},
        )

    def presign_model_preview(self, object_key: str, *, ttl_seconds: int) -> PresignedDownload:
        if object_key not in self.model_preview:
            raise StorageObjectMissing
        return PresignedDownload(
            url=f"https://preview.invalid/{quote(object_key, safe='/')}?ttl={ttl_seconds}"
        )

    def head_model_preview(self, object_key: str) -> StorageObjectMetadata:
        try:
            item = self.model_preview[object_key]
        except KeyError:
            raise StorageObjectMissing from None
        return StorageObjectMetadata(
            size_bytes=len(item.content),
            content_type=item.content_type,
            etag=item.etag,
            sha256=sha256(item.content).hexdigest(),
        )

    def _staging_object(self, object_key: str) -> _FakeObject:
        try:
            return self.staging[object_key]
        except KeyError:
            raise StorageObjectMissing from None
