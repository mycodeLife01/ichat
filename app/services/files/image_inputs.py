"""Resolve immutable image snapshots to short-lived model preview URLs.

The agent kernel intentionally knows nothing about the files database or object
storage.  This adapter is the files-service boundary that turns an
``ImageBlock`` snapshot into a fresh, least-privilege preview URL immediately
before a provider call.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from time import perf_counter
from typing import Any, NoReturn
from uuid import UUID

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.messages import ImageBlock
from app.agent.provider import ImageInputError, ImageInputResolver, ResolvedImageInput
from app.models.files import (
    FileAsset,
    FileModelInputKind,
    FileObject,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
)
from app.services.files.protocols import PresignedDownload, PreviewLlmSigner
from app.services.files.storage import StorageObjectMissing, StoragePermissionDenied
from app.services.files.telemetry import emit_image_input_resolution

_UNAVAILABLE_CODE = "image_input_unavailable"
_UNAVAILABLE_MESSAGE = "Image input could not be resolved"
_IMAGE_PREVIEW_MEDIA_TYPE = "image/webp"
_IMAGE_PROCESSOR_VERSION = "image-v1"
_MAX_IMAGE_EDGE = 8_192
_MAX_IMAGE_PIXELS = 20_000_000


class _ResolverFailure(ImageInputError):
    """Content-free resolver error with an internal metric category."""

    def __init__(self, *, category: str, retryable: bool) -> None:
        super().__init__(
            code=_UNAVAILABLE_CODE,
            message=_UNAVAILABLE_MESSAGE,
            retryable=retryable,
        )
        self.category = category


class FileImageInputResolver(ImageInputResolver):
    """Validate image snapshots in one query and sign each preview once.

    ``session_factory`` is owned by the worker composition root.  The resolver
    opens a short-lived read-only session per model call; no ORM object or
    storage detail escapes this module's narrow agent protocol.
    """

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        signer: PreviewLlmSigner,
        ttl_seconds: int,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        self._session_factory = session_factory
        self._signer = signer
        self._ttl_seconds = ttl_seconds

    async def resolve(
        self, images: Sequence[ImageBlock]
    ) -> Mapping[str, ResolvedImageInput]:
        """Resolve a batch of immutable image snapshots.

        Permanent asset/snapshot failures and permanent signer failures use the
        same stable ``image_input_unavailable`` code.  Database and transient
        signer failures use that code with ``retryable=True`` so the existing
        provider/executor retry boundary can make the decision without seeing
        implementation details.
        """

        started = perf_counter()
        image_count = len(images)
        try:
            unique = self._deduplicate(images)
            if not unique:
                return self._finish_success({}, image_count=image_count, started=started)

            rows = await self._load_rows(unique)
            self._validate_rows(unique, rows)
            resolved = await self._sign_rows(unique, rows)
            return self._finish_success(resolved, image_count=image_count, started=started)
        except ImageInputError as exc:
            emit_image_input_resolution(
                image_count=image_count,
                outcome="failed",
                duration_seconds=perf_counter() - started,
                error_code=(
                    exc.category if isinstance(exc, _ResolverFailure) else "resolver_failure"
                ),
                retryable=exc.retryable,
            )
            raise
        except Exception:
            # Keep this final guard content-free.  The database adapter or a
            # future signer implementation must never leak its raw exception
            # through the provider boundary or into structured logs.
            emit_image_input_resolution(
                image_count=image_count,
                outcome="failed",
                duration_seconds=perf_counter() - started,
                error_code="resolver_unexpected",
                retryable=True,
            )
            raise _ResolverFailure(category="resolver_unexpected", retryable=True) from None

    def _finish_success(
        self,
        resolved: Mapping[str, ResolvedImageInput],
        *,
        image_count: int,
        started: float,
    ) -> Mapping[str, ResolvedImageInput]:
        emit_image_input_resolution(
            image_count=image_count,
            outcome="succeeded",
            duration_seconds=perf_counter() - started,
        )
        return resolved

    @staticmethod
    def _deduplicate(images: Sequence[ImageBlock]) -> list[tuple[UUID, ImageBlock]]:
        """Normalize public UUIDs and reject conflicting duplicate snapshots."""

        unique: dict[UUID, ImageBlock] = {}
        try:
            for block in images:
                if not isinstance(block, ImageBlock):
                    raise ValueError
                if not isinstance(block.file_id, str) or not block.file_id:
                    raise ValueError
                identity = UUID(block.file_id)
                previous = unique.get(identity)
                if previous is not None and not _same_snapshot(previous, block):
                    raise ValueError
                unique.setdefault(identity, block)
        except (AttributeError, TypeError, ValueError):
            raise _ResolverFailure(category="snapshot_identity_invalid", retryable=False) from None
        return list(unique.items())

    async def _load_rows(
        self,
        unique: Sequence[tuple[UUID, ImageBlock]],
    ) -> dict[UUID, tuple[FileAsset, FileObject | None]]:
        public_ids = [identity for identity, _ in unique]
        statement = (
            select(FileAsset, FileObject)
            .outerjoin(
                FileObject,
                and_(
                    FileObject.file_id == FileAsset.id,
                    FileObject.role == FileObjectRole.PREVIEW,
                ),
            )
            .where(FileAsset.public_id.in_(public_ids))
        )
        try:
            async with self._session_factory() as session:
                result = await session.execute(statement)
                rows = result.all()
        except Exception:
            raise _ResolverFailure(category="database_unavailable", retryable=True) from None

        by_public_id: dict[UUID, tuple[FileAsset, FileObject | None]] = {}
        try:
            for asset, preview in rows:
                identity = asset.public_id
                if identity in by_public_id:
                    # A duplicate asset row would violate the public-id
                    # invariant; fail closed instead of choosing one object.
                    raise ValueError
                by_public_id[identity] = (asset, preview)
        except (AttributeError, TypeError, ValueError):
            raise _ResolverFailure(category="database_result_invalid", retryable=False) from None
        return by_public_id

    @staticmethod
    def _validate_rows(
        unique: Sequence[tuple[UUID, ImageBlock]],
        rows: Mapping[UUID, tuple[FileAsset, FileObject | None]],
    ) -> None:
        for identity, block in unique:
            row = rows.get(identity)
            if row is None:
                _raise_permanent("asset_missing")
            asset, preview = row
            if not _asset_is_live(asset):
                _raise_permanent("asset_unavailable")
            if asset.purpose != FilePurpose.MESSAGE_ATTACHMENT:
                _raise_permanent("asset_purpose_invalid")
            if asset.model_input_kind != FileModelInputKind.IMAGE:
                _raise_permanent("asset_kind_invalid")
            if not isinstance(asset.media_type, str) or not asset.media_type.casefold().startswith(
                "image/"
            ):
                _raise_permanent("asset_media_type_invalid")
            if preview is None:
                _raise_permanent("preview_missing")
            if preview.role != FileObjectRole.PREVIEW:
                _raise_permanent("preview_role_invalid")
            if preview.storage_location != FileStorageLocation.MODEL_PREVIEW_PRIVATE:
                _raise_permanent("preview_location_invalid")
            if preview.media_type != _IMAGE_PREVIEW_MEDIA_TYPE:
                _raise_permanent("preview_media_type_invalid")
            if not _positive_int(preview.size_bytes):
                _raise_permanent("preview_size_invalid")
            if block.media_type != _IMAGE_PREVIEW_MEDIA_TYPE:
                _raise_permanent("snapshot_media_type_invalid")
            if not _is_sha256(preview.sha256) or not _is_sha256(block.sha256):
                _raise_permanent("preview_hash_invalid")
            if preview.sha256 != block.sha256:
                _raise_permanent("preview_hash_mismatch")
            metadata = asset.summary_metadata
            width = metadata.get("width") if isinstance(metadata, dict) else None
            height = metadata.get("height") if isinstance(metadata, dict) else None
            if (
                not _positive_int(width)
                or not _positive_int(block.width)
                or width != block.width
            ):
                _raise_permanent("preview_width_mismatch")
            if (
                not _positive_int(height)
                or not _positive_int(block.height)
                or height != block.height
            ):
                _raise_permanent("preview_height_mismatch")
            if width > _MAX_IMAGE_EDGE or height > _MAX_IMAGE_EDGE:
                _raise_permanent("preview_dimensions_exceeded")
            if width * height > _MAX_IMAGE_PIXELS:
                _raise_permanent("preview_pixels_exceeded")
            if asset.extractor_version != _IMAGE_PROCESSOR_VERSION:
                _raise_permanent("processor_version_mismatch")
            if block.processor_version != _IMAGE_PROCESSOR_VERSION:
                _raise_permanent("snapshot_processor_version_mismatch")
            warnings = asset.warnings
            if not isinstance(warnings, list) or not all(
                isinstance(item, str) for item in warnings
            ):
                _raise_permanent("warnings_invalid")
            if tuple(warnings) != block.warnings:
                _raise_permanent("warnings_mismatch")
            if block.filename != asset.original_filename:
                _raise_permanent("snapshot_filename_mismatch")

    async def _sign_rows(
        self,
        unique: Sequence[tuple[UUID, ImageBlock]],
        rows: Mapping[UUID, tuple[FileAsset, FileObject | None]],
    ) -> dict[str, ResolvedImageInput]:
        resolved: dict[str, ResolvedImageInput] = {}
        for identity, block in unique:
            row = rows[identity]
            preview = row[1]
            # Validation has already established that a preview exists and is
            # a model-preview object.  Keep this guard for static type safety
            # and fail closed if a future caller bypasses validation.
            if preview is None:
                _raise_permanent("preview_missing")
            try:
                metadata = await asyncio.to_thread(
                    self._signer.head_model_preview,
                    preview.object_key,
                )
            except (StorageObjectMissing, StoragePermissionDenied):
                _raise_permanent("preview_object_unavailable")
            except ImageInputError as exc:
                raise _ResolverFailure(
                    category="preview_head_rejected",
                    retryable=exc.retryable,
                ) from None
            except Exception:
                raise _ResolverFailure(
                    category="preview_head_unavailable", retryable=True
                ) from None
            if (
                metadata.size_bytes != preview.size_bytes
                or metadata.content_type != preview.media_type
                or metadata.sha256 != preview.sha256
            ):
                _raise_permanent("preview_object_mismatch")
            try:
                signed: Any = await asyncio.to_thread(
                    self._signer.presign_model_preview,
                    preview.object_key,
                    ttl_seconds=self._ttl_seconds,
                )
            except (StorageObjectMissing, StoragePermissionDenied):
                _raise_permanent("preview_signature_denied")
            except ImageInputError as exc:
                # A signer implementation is outside this service boundary;
                # preserve only retry classification and replace any code or
                # message that might carry storage/provider details.
                raise _ResolverFailure(
                    category="signer_rejected",
                    retryable=exc.retryable,
                ) from None
            except Exception:
                raise _ResolverFailure(category="signer_unavailable", retryable=True) from None
            if not isinstance(signed, PresignedDownload) or not isinstance(signed.url, str):
                _raise_permanent("preview_signature_invalid")
            if not signed.url:
                _raise_permanent("preview_signature_invalid")
            resolved[block.file_id] = ResolvedImageInput(
                file_id=block.file_id,
                url=signed.url,
            )
        return resolved


def _same_snapshot(left: ImageBlock, right: ImageBlock) -> bool:
    """Compare duplicate identities without treating UUID casing as content."""

    return (
        left.filename == right.filename
        and left.media_type == right.media_type
        and left.sha256 == right.sha256
        and left.width == right.width
        and left.height == right.height
        and left.processor_version == right.processor_version
        and left.warnings == right.warnings
    )


def _asset_is_live(asset: FileAsset) -> bool:
    return (
        asset.bound_at is not None
        and asset.source_message_id is not None
        and asset.detached_at is None
        and asset.deletion_started_at is None
    )


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdef" for char in value)
    )


def _raise_permanent(reason: str) -> NoReturn:
    # ``reason`` is deliberately not included in the exception message.  The
    # resolver logs only a stable aggregate category and the provider sees a
    # single content-free public error code.
    raise _ResolverFailure(category=reason, retryable=False) from None
