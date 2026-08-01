"""Small adapter seams and value types owned by the files domain.

The domain service deliberately depends on these narrow protocols instead of an
S3 SDK, clamd client, or parser implementation.  In particular, none of the
types here carry a bucket name, a temporary path, or an unredacted parser
exception across the public boundary.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from hashlib import sha256
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from app.services.files.formats import FormatPolicy


DerivativeRole = Literal["original", "preview", "document_extract"]
ProcessedFileKind = Literal["document", "display_only"]
ObjectDisposition = Literal["inline", "attachment"]


class ScanVerdict(StrEnum):
    """The only successful outcomes a malware scanner may return."""

    CLEAN = "clean"
    INFECTED = "infected"


class FileProcessingError(Exception):
    """A stable, content-free processing failure suitable for persistence.

    ``code`` is intentionally the complete message.  Callers must not attach
    original parser exceptions, source bytes, names, URLs, or local paths to
    this exception before logging it.
    """

    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class PresignedUpload:
    url: str
    headers: Mapping[str, str]


@dataclass(frozen=True)
class PresignedDownload:
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class StorageObjectMetadata:
    size_bytes: int
    content_type: str
    etag: str
    declared_size_bytes: int | None = None


# Kept as a familiar spelling for adapter callers migrating from the avatar
# storage seam. Both names denote the same content-free metadata value.
ObjectMetadata = StorageObjectMetadata


@dataclass(frozen=True)
class FileDerivative:
    """One immutable physical representation produced from an upload."""

    role: DerivativeRole
    content_type: str
    content: bytes

    @property
    def size_bytes(self) -> int:
        return len(self.content)

    @property
    def sha256_hex(self) -> str:
        return sha256(self.content).hexdigest()


@dataclass(frozen=True)
class ProcessedFile:
    """Safe parser output for one already-scanned original file.

    The service persists the returned derivatives through its output manifest;
    parser implementations never write objects themselves.  ``metadata`` is
    restricted to non-sensitive, bounded extraction facts (for example page
    or cell counts) and must never contain source names or source text.
    """

    format: str
    media_type: str
    kind: ProcessedFileKind
    derivatives: tuple[FileDerivative, ...]
    warnings: tuple[str, ...] = ()
    metadata: Mapping[str, int | str | bool] = field(default_factory=dict)
    extractor_version: str = "files-v1"

    @property
    def original(self) -> FileDerivative:
        return self.derivative("original")

    @property
    def document_extract(self) -> FileDerivative | None:
        return next((item for item in self.derivatives if item.role == "document_extract"), None)

    @property
    def preview(self) -> FileDerivative | None:
        return next((item for item in self.derivatives if item.role == "preview"), None)

    def derivative(self, role: DerivativeRole) -> FileDerivative:
        for item in self.derivatives:
            if item.role == role:
                return item
        raise LookupError(role)


class UploadStorage(Protocol):
    """The API credential's upload/confirm subset of private storage."""

    def presign_upload(
        self,
        object_key: str,
        *,
        size_bytes: int,
        ttl_seconds: int,
        content_type: str,
    ) -> PresignedUpload: ...

    def head_staging(self, object_key: str) -> StorageObjectMetadata: ...


class WorkerStorage(Protocol):
    """The file-worker's staging/canonical mutation subset."""

    def get_staging(self, object_key: str, *, if_match: str) -> bytes: ...

    def delete_staging(self, object_key: str) -> None: ...

    def put_canonical(self, object_key: str, *, content: bytes, content_type: str) -> None: ...

    def delete_canonical(self, object_key: str) -> None: ...


class DownloadSigner(Protocol):
    """The read API credential's short-lived canonical GET signing subset."""

    def presign_download(
        self,
        object_key: str,
        *,
        ttl_seconds: int,
        disposition: ObjectDisposition,
        filename: str,
    ) -> PresignedDownload: ...


class FileStorage(UploadStorage, WorkerStorage, DownloadSigner, Protocol):
    """Full private storage protocol, used only by orchestration tests/fakes."""


class MalwareScanner(Protocol):
    """A fail-closed scanner. Unavailability is raised, never treated as clean."""

    def scan(self, content: bytes) -> ScanVerdict: ...


class FileParser(Protocol):
    """Parser adapter; callers choose direct or resource-limited execution."""

    def parse(self, content: bytes, policy: FormatPolicy) -> ProcessedFile: ...


class FileTaskPublisher(Protocol):
    """Best-effort queue wakeup, never the source of upload truth."""

    def publish(self, upload_id: str) -> None: ...


class FakeFileTaskPublisher:
    """In-memory publisher for ordinary CI; it exposes no task backend."""

    def __init__(self) -> None:
        self.upload_ids: list[str] = []

    def publish(self, upload_id: str) -> None:
        self.upload_ids.append(upload_id)
