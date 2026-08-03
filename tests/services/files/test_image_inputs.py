"""Batch image-input resolution at the files/agent protocol seam."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from loguru import logger

from app.agent.messages import ImageBlock
from app.agent.provider import ImageInputError, ResolvedImageInput
from app.models.files import (
    FileAsset,
    FileModelInputKind,
    FileObject,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
)
from app.services.files.image_inputs import FileImageInputResolver
from app.services.files.protocols import PresignedDownload, StorageObjectMetadata
from app.services.files.storage import StorageObjectMissing, StoragePermissionDenied


class _Result:
    def __init__(self, rows: list[tuple[FileAsset, FileObject | None]]) -> None:
        self._rows = rows

    def all(self) -> list[tuple[FileAsset, FileObject | None]]:
        return self._rows


class _Session:
    def __init__(
        self,
        rows: list[tuple[FileAsset, FileObject | None]],
        *,
        failure: Exception | None = None,
    ) -> None:
        self.rows = rows
        self.failure = failure
        self.execute_count = 0

    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute(self, _statement: object) -> _Result:
        self.execute_count += 1
        if self.failure is not None:
            raise self.failure
        return _Result(self.rows)


class _Signer:
    def __init__(
        self,
        *,
        failure: Exception | None = None,
        head_failure: Exception | None = None,
        metadata: StorageObjectMetadata | None = None,
        url: str = "https://safe.invalid/p",
    ):
        self.failure = failure
        self.head_failure = head_failure
        self.metadata = metadata or StorageObjectMetadata(
            size_bytes=12,
            content_type="image/webp",
            etag="preview-etag",
            sha256="b" * 64,
        )
        self.url = url
        self.head_calls: list[str] = []
        self.calls: list[tuple[str, int]] = []

    def head_model_preview(self, object_key: str) -> StorageObjectMetadata:
        self.head_calls.append(object_key)
        if self.head_failure is not None:
            raise self.head_failure
        return self.metadata

    def presign_model_preview(self, object_key: str, *, ttl_seconds: int) -> PresignedDownload:
        self.calls.append((object_key, ttl_seconds))
        if self.failure is not None:
            raise self.failure
        return PresignedDownload(url=self.url)


class _Factory:
    def __init__(self, session: _Session) -> None:
        self.session = session

    def __call__(self) -> _Session:
        return self.session


def _asset_and_block(
    *,
    public_id: UUID | None = None,
    object_key: str = "files/private-preview-secret",
) -> tuple[FileAsset, FileObject, ImageBlock]:
    file_public_id = public_id or uuid4()
    asset = FileAsset(
        id=17,
        public_id=file_public_id,
        user_id=4,
        purpose=FilePurpose.MESSAGE_ATTACHMENT,
        original_filename="photo.png",
        media_type="image/png",
        size_bytes=32,
        warnings=["animated_first_frame"],
        extractor_version="image-v1",
        summary_metadata={"width": 320, "height": 240},
        model_input_kind=FileModelInputKind.IMAGE,
        bound_at=datetime(2026, 8, 1, tzinfo=UTC),
        source_message_id=91,
    )
    preview = FileObject(
        id=19,
        file_id=asset.id,
        role=FileObjectRole.PREVIEW,
        storage_location=FileStorageLocation.MODEL_PREVIEW_PRIVATE,
        object_key=object_key,
        media_type="image/webp",
        size_bytes=12,
        sha256="b" * 64,
    )
    block = ImageBlock(
        file_id=str(file_public_id),
        filename="photo.png",
        media_type="image/webp",
        sha256="b" * 64,
        width=320,
        height=240,
        processor_version="image-v1",
        warnings=("animated_first_frame",),
    )
    return asset, preview, block


def _resolver(
    rows: list[tuple[FileAsset, FileObject | None]],
    signer: _Signer,
    *,
    failure: Exception | None = None,
) -> tuple[FileImageInputResolver, _Session]:
    session = _Session(rows, failure=failure)
    resolver = FileImageInputResolver(
        session_factory=_Factory(session),  # type: ignore[arg-type]
        signer=signer,
        ttl_seconds=300,
    )
    return resolver, session


async def test_deduplicates_by_file_identity_with_one_query_and_one_signature() -> None:
    asset, preview, block = _asset_and_block()
    resolver, session = _resolver([(asset, preview)], _Signer())

    resolved = await resolver.resolve((block, block))

    assert resolved == {
        block.file_id: ResolvedImageInput(file_id=block.file_id, url="https://safe.invalid/p")
    }
    assert session.execute_count == 1
    assert resolver._signer.head_calls == [preview.object_key]  # type: ignore[attr-defined]
    assert len(resolver._signer.calls) == 1  # type: ignore[attr-defined]


async def test_success_uses_configured_ttl_and_returns_protocol_value() -> None:
    asset, preview, block = _asset_and_block()
    signer = _Signer(url="https://safe.invalid/short-lived")
    resolver, _ = _resolver([(asset, preview)], signer)

    resolved = await resolver.resolve((block,))

    assert resolved[block.file_id].url == "https://safe.invalid/short-lived"
    assert signer.calls == [(preview.object_key, 300)]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda asset, preview, block: setattr(asset, "bound_at", None),
        lambda asset, preview, block: setattr(asset, "source_message_id", None),
        lambda asset, preview, block: setattr(asset, "detached_at", datetime.now(UTC)),
        lambda asset, preview, block: setattr(asset, "deletion_started_at", datetime.now(UTC)),
        lambda asset, preview, block: setattr(asset, "purpose", FilePurpose.AVATAR),
        lambda asset, preview, block: setattr(
            asset, "model_input_kind", FileModelInputKind.DOCUMENT
        ),
        lambda asset, preview, block: setattr(
            preview, "storage_location", FileStorageLocation.CANONICAL_PRIVATE
        ),
        lambda asset, preview, block: setattr(preview, "media_type", "image/png"),
        lambda asset, preview, block: setattr(preview, "sha256", "c" * 64),
        lambda asset, preview, block: setattr(
            asset, "summary_metadata", {"width": 1, "height": 240}
        ),
        lambda asset, preview, block: setattr(asset, "extractor_version", "files-v1"),
        lambda asset, preview, block: setattr(asset, "warnings", ["different"]),
    ],
)
async def test_each_permanent_snapshot_validation_failure_is_not_retryable(
    mutate: Callable[[FileAsset, FileObject, ImageBlock], None],
) -> None:
    asset, preview, block = _asset_and_block()
    mutate(asset, preview, block)
    resolver, _ = _resolver([(asset, preview)], _Signer())

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is False


async def test_missing_asset_or_preview_is_permanent() -> None:
    _asset, _preview, block = _asset_and_block()
    resolver, _ = _resolver([], _Signer())

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is False


@pytest.mark.parametrize("failure", [RuntimeError("database URL secret")])
async def test_database_failure_is_retryable_and_content_free(failure: Exception) -> None:
    _asset, _preview, block = _asset_and_block()
    resolver, _ = _resolver([], _Signer(), failure=failure)

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is True
    assert "database URL secret" not in exc_info.value.message


async def test_transient_signer_failure_is_retryable() -> None:
    asset, preview, block = _asset_and_block()
    resolver, _ = _resolver([(asset, preview)], _Signer(failure=RuntimeError("bucket/key secret")))

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is True
    assert "bucket/key secret" not in exc_info.value.message


@pytest.mark.parametrize("failure", [StorageObjectMissing(), StoragePermissionDenied()])
async def test_missing_object_or_permission_failure_is_permanent(failure: Exception) -> None:
    asset, preview, block = _asset_and_block()
    resolver, _ = _resolver([(asset, preview)], _Signer(failure=failure))

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is False


@pytest.mark.parametrize("failure", [StorageObjectMissing(), StoragePermissionDenied()])
async def test_missing_preview_is_rejected_before_signing(failure: Exception) -> None:
    asset, preview, block = _asset_and_block()
    signer = _Signer(head_failure=failure)
    resolver, _ = _resolver([(asset, preview)], signer)

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.code == "image_input_unavailable"
    assert exc_info.value.retryable is False
    assert signer.head_calls == [preview.object_key]
    assert signer.calls == []


async def test_preview_object_metadata_mismatch_is_permanent() -> None:
    asset, preview, block = _asset_and_block()
    signer = _Signer(
        metadata=StorageObjectMetadata(
            size_bytes=preview.size_bytes,
            content_type=preview.media_type,
            etag="preview-etag",
            sha256="c" * 64,
        )
    )
    resolver, _ = _resolver([(asset, preview)], signer)

    with pytest.raises(ImageInputError) as exc_info:
        await resolver.resolve((block,))

    assert exc_info.value.retryable is False
    assert signer.calls == []


async def test_logs_contain_only_safe_aggregate_fields() -> None:
    asset, preview, block = _asset_and_block(object_key="bucket/private/object-name-secret")
    signer = _Signer(url="https://signed.invalid/bucket/private/object-name-secret?sig=secret")
    resolver, _ = _resolver([(asset, preview)], signer)
    lines: list[str] = []
    sink_id = logger.add(lines.append, serialize=True)
    try:
        await resolver.resolve((block,))
    finally:
        logger.remove(sink_id)

    output = "".join(lines)
    for forbidden in (
        "bucket/private/object-name-secret",
        "https://signed.invalid",
        "photo.png",
        "b" * 64,
    ):
        assert forbidden not in output
    assert "files_image_input_resolution" in output
    assert "image_count" in output
