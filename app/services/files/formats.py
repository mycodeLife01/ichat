"""The fixed, server-controlled attachment format policy.

Filename extensions select a policy at upload creation time.  The parser still
verifies the real byte format before an upload can become ready; a browser MIME
type is only an early compatibility check and never establishes trust.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePath

from app.services.files.protocols import FileProcessingError, ProcessedFileKind

MiB = 1024 * 1024
TEXT_MAX_BYTES = 2 * MiB
IMAGE_MAX_BYTES = 10 * MiB
PDF_MAX_BYTES = 25 * MiB
OOXML_MAX_BYTES = 20 * MiB


class FileFormat(StrEnum):
    TXT = "txt"
    MD = "md"
    CSV = "csv"
    JSON = "json"
    YAML = "yaml"
    PY = "py"
    JS = "js"
    TS = "ts"
    GO = "go"
    JAVA = "java"
    SQL = "sql"
    JPG = "jpg"
    JPEG = "jpg"
    PNG = "png"
    WEBP = "webp"
    PDF = "pdf"
    DOCX = "docx"
    PPTX = "pptx"
    XLSX = "xlsx"


@dataclass(frozen=True)
class FormatPolicy:
    format: FileFormat
    extensions: frozenset[str]
    media_type: str
    declared_media_types: frozenset[str]
    max_bytes: int
    kind: ProcessedFileKind

    @property
    def is_document(self) -> bool:
        return self.kind == "document"

    @property
    def is_image(self) -> bool:
        return self.kind == "display_only"


def _policy(
    file_format: FileFormat,
    *,
    extensions: tuple[str, ...],
    media_type: str,
    aliases: tuple[str, ...] = (),
    max_bytes: int,
    kind: ProcessedFileKind,
) -> FormatPolicy:
    return FormatPolicy(
        format=file_format,
        extensions=frozenset(extensions),
        media_type=media_type,
        declared_media_types=frozenset((media_type, *aliases)),
        max_bytes=max_bytes,
        kind=kind,
    )


FORMAT_POLICIES: tuple[FormatPolicy, ...] = (
    _policy(
        FileFormat.TXT,
        extensions=("txt",),
        media_type="text/plain",
        aliases=("application/octet-stream",),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.MD,
        extensions=("md",),
        media_type="text/markdown",
        aliases=("text/x-markdown", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.CSV,
        extensions=("csv",),
        media_type="text/csv",
        aliases=("application/csv", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.JSON,
        extensions=("json",),
        media_type="application/json",
        aliases=("text/json", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.YAML,
        extensions=("yaml", "yml"),
        media_type="application/x-yaml",
        aliases=("text/yaml", "text/x-yaml", "application/yaml", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.PY,
        extensions=("py",),
        media_type="text/x-python",
        aliases=("text/plain", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.JS,
        extensions=("js",),
        media_type="text/javascript",
        aliases=(
            "application/javascript",
            "application/x-javascript",
            "text/plain",
            "application/octet-stream",
        ),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.TS,
        extensions=("ts",),
        media_type="text/typescript",
        aliases=("application/typescript", "text/plain", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.GO,
        extensions=("go",),
        media_type="text/x-go",
        aliases=("text/plain", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.JAVA,
        extensions=("java",),
        media_type="text/x-java-source",
        aliases=("text/plain", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.SQL,
        extensions=("sql",),
        media_type="application/sql",
        aliases=("text/sql", "text/plain", "application/octet-stream"),
        max_bytes=TEXT_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.JPG,
        extensions=("jpg", "jpeg"),
        media_type="image/jpeg",
        aliases=("image/pjpeg",),
        max_bytes=IMAGE_MAX_BYTES,
        kind="display_only",
    ),
    _policy(
        FileFormat.PNG,
        extensions=("png",),
        media_type="image/png",
        max_bytes=IMAGE_MAX_BYTES,
        kind="display_only",
    ),
    _policy(
        FileFormat.WEBP,
        extensions=("webp",),
        media_type="image/webp",
        max_bytes=IMAGE_MAX_BYTES,
        kind="display_only",
    ),
    _policy(
        FileFormat.PDF,
        extensions=("pdf",),
        media_type="application/pdf",
        aliases=("application/x-pdf",),
        max_bytes=PDF_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.DOCX,
        extensions=("docx",),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        max_bytes=OOXML_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.PPTX,
        extensions=("pptx",),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        max_bytes=OOXML_MAX_BYTES,
        kind="document",
    ),
    _policy(
        FileFormat.XLSX,
        extensions=("xlsx",),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        max_bytes=OOXML_MAX_BYTES,
        kind="document",
    ),
)

_POLICY_BY_EXTENSION = {
    extension: policy for policy in FORMAT_POLICIES for extension in policy.extensions
}
_POLICY_BY_FORMAT = {policy.format: policy for policy in FORMAT_POLICIES}


def normalized_extension(filename: str) -> str:
    """Return a simple lower-case suffix without allowing path traversal."""

    # ``PurePath`` accepts both usual separators on the host platform.  A
    # backslash is normalized separately because uploads may originate on a
    # different OS than the API host.
    basename = PurePath(filename.replace("\\", "/")).name
    if not basename or basename in {".", ".."}:
        return ""
    suffix = PurePath(basename).suffix
    return suffix[1:].casefold() if suffix else ""


def policy_for_filename(filename: str) -> FormatPolicy:
    policy = _POLICY_BY_EXTENSION.get(normalized_extension(filename))
    if policy is None:
        raise FileProcessingError("unsupported_file_type")
    return policy


def policy_for_format(file_format: FileFormat | str) -> FormatPolicy:
    try:
        normalized = FileFormat(file_format)
    except ValueError:
        if isinstance(file_format, str):
            by_extension = _POLICY_BY_EXTENSION.get(file_format.removeprefix(".").casefold())
            if by_extension is not None:
                return by_extension
        raise FileProcessingError("unsupported_file_type") from None
    return _POLICY_BY_FORMAT[normalized]


def is_declared_content_type_compatible(policy: FormatPolicy, content_type: str) -> bool:
    """Check only an untrusted browser declaration, ignoring parameters."""

    normalized = content_type.split(";", 1)[0].strip().casefold()
    return not normalized or normalized in policy.declared_media_types


def validate_upload_declaration(
    *, filename: str,
    content_type: str,
    size_bytes: int,
) -> FormatPolicy:
    """Perform cheap creation-time policy validation without trusting bytes."""

    policy = policy_for_filename(filename)
    if size_bytes < 0 or size_bytes > policy.max_bytes:
        raise FileProcessingError("file_too_large")
    if not is_declared_content_type_compatible(policy, content_type):
        raise FileProcessingError("content_type_mismatch")
    return policy


def supported_extensions() -> tuple[str, ...]:
    return tuple(sorted(_POLICY_BY_EXTENSION))
