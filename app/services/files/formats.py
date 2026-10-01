"""The fixed, server-controlled attachment format policy.

Filename extensions select an initial policy at upload creation time; an
unlisted extension falls back to plain text.  The parser sniffs the real byte
format before an upload can become ready and may only correct the policy within
the same category.  A browser MIME type is an untrusted diagnostic hint and
never establishes trust.  Size and pixel limits are deployment configuration
(``FileLimits``) injected at runtime, not part of the fixed format table.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePath
from typing import TYPE_CHECKING, Literal

from app.services.files.protocols import FileProcessingError, ProcessedFileKind

if TYPE_CHECKING:
    from app.core.config import Settings

MiB = 1024 * 1024

FileCategory = Literal["image", "pdf", "office", "text"]


@dataclass(frozen=True)
class FileLimits:
    """Deployment-configured size and pixel limits; defaults mirror ``Settings``."""

    text_max_bytes: int = 2 * MiB
    image_max_bytes: int = 30 * MiB
    pdf_max_bytes: int = 50 * MiB
    office_max_bytes: int = 30 * MiB
    image_max_pixels: int = 80_000_000
    image_max_edge: int = 16_384

    @classmethod
    def from_settings(cls, settings: Settings) -> FileLimits:
        return cls(
            text_max_bytes=settings.files_text_max_bytes,
            image_max_bytes=settings.files_image_max_bytes,
            pdf_max_bytes=settings.files_pdf_max_bytes,
            office_max_bytes=settings.files_office_max_bytes,
            image_max_pixels=settings.files_image_max_pixels,
            image_max_edge=settings.files_image_max_edge,
        )

    def max_bytes(self, category: FileCategory) -> int:
        match category:
            case "image":
                return self.image_max_bytes
            case "pdf":
                return self.pdf_max_bytes
            case "office":
                return self.office_max_bytes
            case "text":
                return self.text_max_bytes

    def category_max_bytes(self) -> dict[str, int]:
        return {
            "image": self.image_max_bytes,
            "pdf": self.pdf_max_bytes,
            "office": self.office_max_bytes,
            "text": self.text_max_bytes,
        }


DEFAULT_FILE_LIMITS = FileLimits()

# Version of the image preview derivation. Bump it whenever preview pixels can
# change; readers keep accepting older versions so existing snapshots replay.
IMAGE_PROCESSOR_VERSION = "image-v2"
SUPPORTED_IMAGE_PROCESSOR_VERSIONS = frozenset({"image-v1", IMAGE_PROCESSOR_VERSION})


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
    GIF = "gif"
    HEIC = "heic"
    PDF = "pdf"
    DOCX = "docx"
    PPTX = "pptx"
    XLSX = "xlsx"


PLAIN_TEXT_EXTENSIONS = (
    "txt",
    "text",
    "log",
    "tsv",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "xml",
    "svg",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cxx",
    "cs",
    "rs",
    "rb",
    "php",
    "kt",
    "kts",
    "swift",
    "scala",
    "dart",
    "lua",
    "r",
    "pl",
    "m",
    "vue",
    "svelte",
    "graphql",
    "gql",
    "proto",
    "tex",
    "rst",
    "adoc",
    "diff",
    "patch",
    "dockerfile",
    "makefile",
    "gradle",
    "tf",
    "hcl",
    "lock",
)

TEXT_FILE_FORMATS = frozenset(
    {
        FileFormat.TXT,
        FileFormat.MD,
        FileFormat.CSV,
        FileFormat.JSON,
        FileFormat.YAML,
        FileFormat.PY,
        FileFormat.JS,
        FileFormat.TS,
        FileFormat.GO,
        FileFormat.JAVA,
        FileFormat.SQL,
    }
)


@dataclass(frozen=True)
class FormatPolicy:
    format: FileFormat
    extensions: frozenset[str]
    media_type: str
    declared_media_types: frozenset[str]
    category: FileCategory
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
    category: FileCategory,
    kind: ProcessedFileKind,
) -> FormatPolicy:
    return FormatPolicy(
        format=file_format,
        extensions=frozenset(extensions),
        media_type=media_type,
        declared_media_types=frozenset((media_type, *aliases)),
        category=category,
        kind=kind,
    )


FORMAT_POLICIES: tuple[FormatPolicy, ...] = (
    _policy(
        FileFormat.TXT,
        # Plain-text formats without a dedicated parser.  They are all stored
        # as text/plain so a downloaded original is never rendered as markup.
        extensions=PLAIN_TEXT_EXTENSIONS,
        media_type="text/plain",
        aliases=("application/octet-stream",),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.MD,
        extensions=("md",),
        media_type="text/markdown",
        aliases=("text/x-markdown", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.CSV,
        extensions=("csv",),
        media_type="text/csv",
        aliases=("application/csv", "application/vnd.ms-excel", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.JSON,
        extensions=("json",),
        media_type="application/json",
        aliases=("text/json", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.YAML,
        extensions=("yaml", "yml"),
        media_type="application/x-yaml",
        aliases=("text/yaml", "text/x-yaml", "application/yaml", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.PY,
        extensions=("py",),
        media_type="text/x-python",
        aliases=("text/plain", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.JS,
        extensions=("js", "jsx", "mjs", "cjs"),
        media_type="text/javascript",
        aliases=(
            "application/javascript",
            "application/x-javascript",
            "text/plain",
            "application/octet-stream",
        ),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.TS,
        extensions=("ts", "tsx", "mts", "cts"),
        media_type="text/typescript",
        aliases=(
            "application/typescript",
            "text/plain",
            "video/mp2t",
            "application/octet-stream",
        ),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.GO,
        extensions=("go",),
        media_type="text/x-go",
        aliases=("text/plain", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.JAVA,
        extensions=("java",),
        media_type="text/x-java-source",
        aliases=("text/plain", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.SQL,
        extensions=("sql",),
        media_type="application/sql",
        aliases=("application/x-sql", "text/sql", "text/plain", "application/octet-stream"),
        category="text",
        kind="document",
    ),
    _policy(
        FileFormat.JPG,
        extensions=("jpg", "jpeg"),
        media_type="image/jpeg",
        aliases=("image/pjpeg",),
        category="image",
        kind="display_only",
    ),
    _policy(
        FileFormat.PNG,
        extensions=("png",),
        media_type="image/png",
        category="image",
        kind="display_only",
    ),
    _policy(
        FileFormat.WEBP,
        extensions=("webp",),
        media_type="image/webp",
        category="image",
        kind="display_only",
    ),
    _policy(
        FileFormat.GIF,
        extensions=("gif",),
        media_type="image/gif",
        category="image",
        kind="display_only",
    ),
    _policy(
        FileFormat.HEIC,
        extensions=("heic", "heif"),
        media_type="image/heic",
        aliases=("image/heif", "image/heic-sequence", "image/heif-sequence"),
        category="image",
        kind="display_only",
    ),
    _policy(
        FileFormat.PDF,
        extensions=("pdf",),
        media_type="application/pdf",
        aliases=("application/x-pdf",),
        category="pdf",
        kind="document",
    ),
    _policy(
        FileFormat.DOCX,
        extensions=("docx",),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        category="office",
        kind="document",
    ),
    _policy(
        FileFormat.PPTX,
        extensions=("pptx",),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        category="office",
        kind="document",
    ),
    _policy(
        FileFormat.XLSX,
        extensions=("xlsx",),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        category="office",
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


# Unlisted and extension-less files (``Dockerfile``, ``.env``) are admitted as
# plain text; the worker's decoding, NUL, and binary-signature checks decide.
TEXT_FALLBACK_POLICY = _POLICY_BY_FORMAT[FileFormat.TXT]
OFFICE_MEDIA_TYPES = frozenset(
    policy.media_type for policy in FORMAT_POLICIES if policy.category == "office"
)


def policy_for_filename(filename: str) -> FormatPolicy:
    return _POLICY_BY_EXTENSION.get(normalized_extension(filename), TEXT_FALLBACK_POLICY)


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
    """Check only an untrusted, platform-dependent browser MIME hint."""

    normalized = content_type.split(";", 1)[0].strip().casefold()
    if not normalized or normalized == "application/octet-stream":
        return True
    if normalized in policy.declared_media_types:
        return True
    # OS MIME databases assign different vendor text types to source files.
    # Text syntax is intentionally not required to be valid, so the worker's
    # UTF-8, NUL, and non-text magic checks remain the authoritative boundary.
    return policy.format in TEXT_FILE_FORMATS and normalized.startswith("text/")


def validate_upload_declaration(
    *, filename: str,
    content_type: str,
    size_bytes: int,
    limits: FileLimits = DEFAULT_FILE_LIMITS,
) -> FormatPolicy:
    """Perform cheap creation-time policy validation without trusting bytes."""

    policy = policy_for_filename(filename)
    if size_bytes < 0 or size_bytes > limits.max_bytes(policy.category):
        raise FileProcessingError("file_too_large")
    # Browser MIME databases are inconsistent and the declaration is
    # attacker-controlled. The worker's byte-level parser remains the
    # authoritative format check, so a conflicting hint must not reject an
    # otherwise valid upload.
    return policy


def supported_extensions() -> tuple[str, ...]:
    return tuple(sorted(_POLICY_BY_EXTENSION))
