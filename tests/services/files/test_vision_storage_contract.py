from __future__ import annotations

from hashlib import sha256

import pytest

from app.models.files import FileStorageLocation
from app.services.files.storage import (
    FakeFileStorage,
    R2FileStorage,
    StorageIntegrityError,
    StoragePermissionDenied,
)


def test_fake_storage_copies_preview_idempotently_and_verifies_existing_bytes() -> None:
    storage = FakeFileStorage()
    content = b"safe-preview"
    digest = sha256(content).hexdigest()
    storage.put_canonical("files/image/preview", content=content, content_type="image/webp")

    first = storage.copy_canonical_to_preview(
        "files/image/preview",
        expected_size_bytes=len(content),
        expected_sha256=digest,
        content_type="image/webp",
    )
    second = storage.copy_canonical_to_preview(
        "files/image/preview",
        expected_size_bytes=len(content),
        expected_sha256=digest,
        content_type="image/webp",
    )

    assert first.sha256 == digest
    assert second.sha256 == digest
    assert list(storage.model_preview) == ["files/image/preview"]

    storage.model_preview["files/image/preview"] = storage.model_preview[
        "files/image/preview"
    ].__class__(b"wrong", "image/webp", "wrong")
    with pytest.raises(StorageIntegrityError):
        storage.copy_canonical_to_preview(
            "files/image/preview",
            expected_size_bytes=len(content),
            expected_sha256=digest,
            content_type="image/webp",
        )


def test_r2_preview_roles_are_read_only_and_bucket_scoped() -> None:
    class Client:
        def generate_presigned_url(
            self,
            operation: str,
            *,
            Params: dict[str, str],
            **kwargs: object,
        ) -> str:
            del operation, kwargs
            return f"https://signed.invalid/{Params['Bucket']}/{Params['Key']}"

    api = R2FileStorage(
        Client(),
        staging_bucket="staging",
        canonical_bucket="canonical",
        preview_bucket="preview",
        credential_role="preview_api",
    )
    signed = api.presign_preview(
        "files/image/preview",
        ttl_seconds=60,
        filename="image.webp",
        storage_location=FileStorageLocation.MODEL_PREVIEW_PRIVATE,
    )
    assert signed.url == "https://signed.invalid/preview/files/image/preview"
    with pytest.raises(StoragePermissionDenied):
        api.put_preview("files/image/preview", content=b"x", content_type="image/webp")
    with pytest.raises(StoragePermissionDenied):
        api.presign_preview(
            "files/image/preview",
            ttl_seconds=60,
            filename="image.webp",
            storage_location=FileStorageLocation.CANONICAL_PRIVATE,
        )

    download = R2FileStorage(
        Client(),
        staging_bucket="staging",
        canonical_bucket="canonical",
        preview_bucket="preview",
        credential_role="download",
    )
    legacy = download.presign_preview(
        "files/image/preview",
        ttl_seconds=60,
        filename="image.webp",
        storage_location=FileStorageLocation.CANONICAL_PRIVATE,
    )
    assert legacy.url == "https://signed.invalid/canonical/files/image/preview"
    with pytest.raises(StoragePermissionDenied):
        download.presign_preview(
            "files/image/preview",
            ttl_seconds=60,
            filename="image.webp",
            storage_location=FileStorageLocation.MODEL_PREVIEW_PRIVATE,
        )

    llm = R2FileStorage(
        Client(),
        staging_bucket="staging",
        canonical_bucket="canonical",
        preview_bucket="preview",
        credential_role="preview_llm",
    )
    assert llm.presign_model_preview("files/image/preview", ttl_seconds=60).url.startswith(
        "https://signed.invalid/preview/"
    )
    with pytest.raises(StoragePermissionDenied):
        llm.presign_preview(
            "files/image/preview",
            ttl_seconds=60,
            filename="image.webp",
            storage_location=FileStorageLocation.CANONICAL_PRIVATE,
        )
