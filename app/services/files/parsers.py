"""Strict, side-effect-free parsers for supported message-attachment formats.

All source bytes are untrusted.  This module only returns immutable parser
output; it neither logs source material nor performs storage, network, formula,
macro, script, or external-reference execution.  The worker should call
``parse_in_subprocess`` for PDF and OOXML inputs so a parser crash or resource
exhaustion cannot contaminate the long-lived file-worker process.
"""

from __future__ import annotations

import csv
import json
import os
import posixpath
import re
import signal
import stat
import subprocess
import sys
import tempfile
import warnings
import xml.etree.ElementTree as ElementTree
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from io import BytesIO, StringIO
from pathlib import Path, PurePosixPath
from typing import cast

from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader

from app.services.files.formats import FileFormat, FormatPolicy, policy_for_format
from app.services.files.protocols import (
    DerivativeRole,
    FileDerivative,
    FileProcessingError,
    ProcessedFile,
    ProcessedFileKind,
)

MAX_CSV_ROWS = 100_000
MAX_CSV_COLUMNS = 256
MAX_IMAGE_EDGE = 8_192
MAX_IMAGE_PIXELS = 20_000_000
MAX_PDF_PAGES = 200
MAX_OOXML_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_OOXML_ENTRIES = 10_000
MAX_OOXML_COMPRESSION_RATIO = 100
MAX_OOXML_XML_BYTES = 50 * 1024 * 1024
MAX_DOCX_NODES = 100_000
MAX_PPTX_VISIBLE_SLIDES = 200
MAX_XLSX_VISIBLE_SHEETS = 50
MAX_XLSX_NONEMPTY_CELLS = 100_000
DEFAULT_PARSER_TIMEOUT_SECONDS = 120.0
DEFAULT_PARSER_MEMORY_BYTES = 512 * 1024 * 1024
MAX_PARSER_RESULT_BYTES = 64 * 1024
MAX_PARSER_DERIVED_BYTES = 128 * 1024 * 1024

DOCUMENT_EXTRACT_MEDIA_TYPE = "text/plain; charset=utf-8"
PREVIEW_MEDIA_TYPE = "image/webp"
WARNING_PARTIAL_CONTENT = "partial_content_not_extracted"
WARNING_ANIMATED_IMAGE_FIRST_FRAME = "animated_image_first_frame_only"
WARNING_COMPLEXITY_LIMIT = "complexity_limit_exceeded"
WARNING_CSV_SHAPE_LIMIT = "csv_shape_limit_exceeded"
WARNING_EMBEDDED_CONTENT = "embedded_content_not_extracted"
WARNING_EXTERNAL_LINKS = "external_links_not_extracted"
WARNING_NO_EXTRACTABLE_TEXT = "no_extractable_text"
WARNING_TEXT_ENCODING_NORMALIZED = "text_encoding_normalized"

_UTF8_BOM = b"\xef\xbb\xbf"
_PDF_HEADER_SEARCH_BYTES = 1_024
_NESTED_ARCHIVE_SUFFIXES = frozenset({".zip", ".jar", ".apk", ".docx", ".pptx", ".xlsx"})
_OLE_COMPOUND_FILE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_CONTENT_TYPE_MAIN_PART = {
    FileFormat.DOCX: (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "word/document.xml",
    ),
    FileFormat.PPTX: (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "ppt/presentation.xml",
    ),
    FileFormat.XLSX: (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "xl/workbook.xml",
    ),
}

_DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

_CELL_REFERENCE_RE = re.compile(r"^([A-Za-z]{1,3})([1-9][0-9]{0,9})$")


class DirectFileParser:
    """Adapter exposing the direct parser seam for small trusted test inputs."""

    def parse(self, content: bytes, policy: FormatPolicy) -> ProcessedFile:
        return parse_file(content, policy)


class RestrictedFileParser:
    """Adapter which routes parsing through the terminable child process seam."""

    def __init__(
        self,
        *,
        timeout_seconds: float = DEFAULT_PARSER_TIMEOUT_SECONDS,
        memory_limit_bytes: int | None = DEFAULT_PARSER_MEMORY_BYTES,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._memory_limit_bytes = memory_limit_bytes

    def parse(self, content: bytes, policy: FormatPolicy) -> ProcessedFile:
        return parse_in_subprocess(
            content,
            policy,
            timeout_seconds=self._timeout_seconds,
            memory_limit_bytes=self._memory_limit_bytes,
        )


class FakeFileParser:
    """Parser fake for service tests that records only non-sensitive facts."""

    def __init__(
        self,
        *,
        result: ProcessedFile | None = None,
        error: FileProcessingError | None = None,
        factory: Callable[[bytes, FormatPolicy], ProcessedFile] | None = None,
    ) -> None:
        if sum(item is not None for item in (result, error, factory)) > 1:
            raise ValueError("choose one fake parser outcome")
        self._result = result
        self._error = error
        self._factory = factory
        self.calls: list[tuple[int, str]] = []

    def parse(self, content: bytes, policy: FormatPolicy) -> ProcessedFile:
        self.calls.append((len(content), policy.format.value))
        if self._error is not None:
            raise self._error
        if self._factory is not None:
            return self._factory(content, policy)
        if self._result is not None:
            return self._result
        return parse_file(content, policy)


def parse_file(content: bytes, policy: FormatPolicy | FileFormat | str) -> ProcessedFile:
    """Parse one already-scanned file directly, with no external side effects."""

    resolved_policy = _resolve_policy(policy)
    if len(content) > resolved_policy.max_bytes:
        raise FileProcessingError("file_too_large")

    match resolved_policy.format:
        case (
            FileFormat.TXT
            | FileFormat.MD
            | FileFormat.CSV
            | FileFormat.JSON
            | FileFormat.YAML
            | FileFormat.PY
            | FileFormat.JS
            | FileFormat.TS
            | FileFormat.GO
            | FileFormat.JAVA
            | FileFormat.SQL
        ):
            return _parse_text(content, resolved_policy)
        case FileFormat.JPG | FileFormat.PNG | FileFormat.WEBP:
            return _parse_image(content, resolved_policy)
        case FileFormat.PDF:
            return _parse_pdf(content, resolved_policy)
        case FileFormat.DOCX:
            return _parse_docx(content, resolved_policy)
        case FileFormat.PPTX:
            return _parse_pptx(content, resolved_policy)
        case FileFormat.XLSX:
            return _parse_xlsx(content, resolved_policy)
    raise FileProcessingError("unsupported_file_type")


def parse_in_subprocess(
    content: bytes,
    policy: FormatPolicy | FileFormat | str,
    *,
    timeout_seconds: float = DEFAULT_PARSER_TIMEOUT_SECONDS,
    memory_limit_bytes: int | None = DEFAULT_PARSER_MEMORY_BYTES,
) -> ProcessedFile:
    """Parse in an independently terminable process with a bounded wait.

    The child returns only the stable error code, never an original exception.
    On platforms supporting ``resource``, soft address-space and CPU limits are
    additionally applied in the child.  The parent timeout is authoritative on
    every platform and always terminates a stuck child before returning.
    """

    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    resolved_policy = _resolve_policy(policy)
    if len(content) > resolved_policy.max_bytes:
        raise FileProcessingError("file_too_large")
    with tempfile.TemporaryDirectory(prefix="ichat-file-parser-") as output_directory:
        project_root = Path(__file__).resolve().parents[3]
        command = [
            sys.executable,
            "-m",
            "app.services.files.parser_worker",
            resolved_policy.format.value,
            output_directory,
            repr(timeout_seconds),
            str(memory_limit_bytes or 0),
            str(os.getpid()),
        ]
        process = subprocess.Popen(  # noqa: S603 - fixed interpreter/module and validated args.
            command,
            cwd=project_root,
            env=_parser_environment(),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=os.name == "posix",
        )
        try:
            process.communicate(input=content, timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            _terminate_parser_process(process)
            raise FileProcessingError("resource_limit") from None
        except BaseException:
            # Celery soft time limits and worker shutdowns must not orphan a
            # parser process that can outlive the attempt and overlap a retry.
            _terminate_parser_process(process)
            raise
        if process.returncode != 0:
            raise FileProcessingError(
                "resource_limit" if process.returncode < 0 else "parser_failed"
            )
        return _load_parser_result(
            Path(output_directory),
            source=content,
            policy=resolved_policy,
        )


def _parser_environment() -> dict[str, str]:
    """Return a minimal child environment with no application credentials."""

    environment = {
        "PATH": os.environ.get("PATH", ""),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
    }
    for name in ("SYSTEMROOT", "WINDIR"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


def _terminate_parser_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:  # pragma: no cover - exercised on Windows runners only.
            process.kill()
    except ProcessLookupError:
        pass
    process.communicate()


def _load_parser_result(
    output_directory: Path,
    *,
    source: bytes,
    policy: FormatPolicy,
) -> ProcessedFile:
    result_path = output_directory / "result.json"
    result_stat = _regular_file_stat(result_path)
    if result_stat.st_size > MAX_PARSER_RESULT_BYTES:
        raise FileProcessingError("parser_failed")
    try:
        raw = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise FileProcessingError("parser_failed") from None
    if not isinstance(raw, dict):
        raise FileProcessingError("parser_failed")
    if raw.get("outcome") == "error":
        code = raw.get("code")
        retryable = raw.get("retryable")
        if isinstance(code, str) and isinstance(retryable, bool):
            raise FileProcessingError(code, retryable=retryable)
        raise FileProcessingError("parser_failed")
    if raw.get("outcome") != "ok" or raw.get("format") != policy.format.value:
        raise FileProcessingError("parser_failed")

    media_type = _bounded_result_string(raw.get("media_type"), maximum=255)
    kind_value = raw.get("kind")
    if media_type != policy.media_type or kind_value != policy.kind:
        raise FileProcessingError("parser_failed")
    kind = cast(ProcessedFileKind, kind_value)
    extractor_version = _bounded_result_string(raw.get("extractor_version"), maximum=100)
    warnings_value = raw.get("warnings")
    if (
        not isinstance(warnings_value, list)
        or len(warnings_value) > 32
        or any(not isinstance(item, str) or len(item) > 128 for item in warnings_value)
    ):
        raise FileProcessingError("parser_failed")
    metadata_value = raw.get("metadata")
    if (
        not isinstance(metadata_value, dict)
        or len(metadata_value) > 64
        or any(
            not isinstance(key, str)
            or len(key) > 100
            or not isinstance(value, int | str | bool)
            or (isinstance(value, str) and len(value) > 512)
            for key, value in metadata_value.items()
        )
    ):
        raise FileProcessingError("parser_failed")

    derivative_rows = raw.get("derivatives")
    if not isinstance(derivative_rows, list) or not 1 <= len(derivative_rows) <= 3:
        raise FileProcessingError("parser_failed")
    derivatives: list[FileDerivative] = []
    roles: set[str] = set()
    derived_bytes = 0
    for index, row in enumerate(derivative_rows):
        if not isinstance(row, dict):
            raise FileProcessingError("parser_failed")
        role_value = row.get("role")
        if role_value not in {"original", "preview", "document_extract"}:
            raise FileProcessingError("parser_failed")
        if not isinstance(role_value, str) or role_value in roles:
            raise FileProcessingError("parser_failed")
        roles.add(role_value)
        content_type = _bounded_result_string(row.get("content_type"), maximum=255)
        if role_value == "original":
            if row.get("source") is not True:
                raise FileProcessingError("parser_failed")
            derivative_content = source
        else:
            expected_name = f"derivative-{index}.bin"
            if row.get("file") != expected_name:
                raise FileProcessingError("parser_failed")
            derivative_path = output_directory / expected_name
            derivative_stat = _regular_file_stat(derivative_path)
            derived_bytes += derivative_stat.st_size
            if derived_bytes > MAX_PARSER_DERIVED_BYTES:
                raise FileProcessingError("resource_limit")
            try:
                derivative_content = derivative_path.read_bytes()
            except OSError:
                raise FileProcessingError("parser_failed") from None
        if row.get("size_bytes") != len(derivative_content):
            raise FileProcessingError("parser_failed")
        if row.get("sha256") != sha256(derivative_content).hexdigest():
            raise FileProcessingError("parser_failed")
        derivatives.append(
            FileDerivative(
                role=cast(DerivativeRole, role_value),
                content_type=content_type,
                content=derivative_content,
            )
        )
    if "original" not in roles:
        raise FileProcessingError("parser_failed")
    return ProcessedFile(
        format=policy.format.value,
        media_type=media_type,
        kind=kind,
        derivatives=tuple(derivatives),
        warnings=tuple(cast(list[str], warnings_value)),
        metadata=cast(dict[str, int | str | bool], metadata_value),
        extractor_version=extractor_version,
    )


def _regular_file_stat(path: Path) -> os.stat_result:
    try:
        result = path.lstat()
    except OSError:
        raise FileProcessingError("parser_failed") from None
    if not stat.S_ISREG(result.st_mode) or stat.S_ISLNK(result.st_mode):
        raise FileProcessingError("parser_failed")
    return result


def _bounded_result_string(value: object, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise FileProcessingError("parser_failed")
    return value


def _apply_child_limits(*, timeout_seconds: float, memory_limit_bytes: int | None) -> None:
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows does not expose resource.
        return

    try:
        cpu_seconds = max(1, int(timeout_seconds) + 1)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        if memory_limit_bytes is not None:
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit_bytes, memory_limit_bytes))
    except (OSError, ValueError):
        # The parent still owns a reliable timeout if the platform rejects a
        # particular rlimit (as some macOS configurations do).
        return


def _resolve_policy(policy: FormatPolicy | FileFormat | str) -> FormatPolicy:
    return policy if isinstance(policy, FormatPolicy) else policy_for_format(policy)


def _parse_text(content: bytes, policy: FormatPolicy) -> ProcessedFile:
    _reject_nontext_magic(content)
    text, encoding_normalized = _decode_text(content)
    metadata: dict[str, int | str | bool] = {"text_bytes": len(text.encode("utf-8"))}
    warnings_out: tuple[str, ...] = (
        (WARNING_TEXT_ENCODING_NORMALIZED,) if encoding_normalized else ()
    )
    if policy.format is FileFormat.CSV:
        row_count, max_columns, shape_limit_exceeded = _inspect_csv_shape(text)
        metadata["row_count"] = row_count
        metadata["max_columns"] = max_columns
        if shape_limit_exceeded:
            warnings_out = _merge_warnings(warnings_out, (WARNING_CSV_SHAPE_LIMIT,))
    return _document_processed(
        policy,
        source=content,
        text=text,
        warnings_out=warnings_out,
        metadata=metadata,
        extractor_version="text-v1",
    )


def _decode_text(content: bytes) -> tuple[str, bool]:
    try:
        if content.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = content.decode("utf-16")
            encoding_normalized = True
        else:
            text = content.decode("utf-8")
            encoding_normalized = False
    except UnicodeDecodeError:
        raise FileProcessingError("invalid_text_encoding") from None
    if content.startswith(_UTF8_BOM):
        text = text.removeprefix("\ufeff")
    if "\0" in text:
        raise FileProcessingError("nul_byte_not_allowed")
    return _normalize_newlines(text), encoding_normalized


def _reject_nontext_magic(content: bytes) -> None:
    """Reject a known binary/document container renamed as a text extension."""

    if (
        content.startswith(b"%PDF-")
        or content.startswith(b"\x89PNG\r\n\x1a\n")
        or content.startswith(b"\xff\xd8\xff")
        or (content.startswith(b"RIFF") and content[8:12] == b"WEBP")
        or content.startswith(b"PK\x03\x04")
        or content.startswith(_OLE_COMPOUND_FILE_MAGIC)
    ):
        raise FileProcessingError("file_format_mismatch")


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _inspect_csv_shape(text: str) -> tuple[int, int, bool]:
    row_count = 0
    max_columns = 0
    limit_exceeded = False
    try:
        reader = csv.reader(StringIO(text, newline=""))
        for row in reader:
            row_count += 1
            if row_count > MAX_CSV_ROWS:
                limit_exceeded = True
            max_columns = max(max_columns, len(row))
            if len(row) > MAX_CSV_COLUMNS:
                limit_exceeded = True
    except csv.Error:
        # CSV syntax is deliberately low-trust text rather than a requirement.
        # Inspect malformed input by physical lines while preserving it verbatim.
        row_count = text.count("\n") + (1 if text else 0)
        if row_count > MAX_CSV_ROWS:
            limit_exceeded = True
        for line in text.splitlines():
            columns = line.count(",") + 1
            max_columns = max(max_columns, columns)
            if columns > MAX_CSV_COLUMNS:
                limit_exceeded = True
    return row_count, max_columns, limit_exceeded


def _parse_image(content: bytes, policy: FormatPolicy) -> ProcessedFile:
    expected_format = {
        FileFormat.JPG: "JPEG",
        FileFormat.PNG: "PNG",
        FileFormat.WEBP: "WEBP",
    }[policy.format]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                if image.format != expected_format:
                    raise FileProcessingError("file_format_mismatch")
                frame_count = getattr(image, "n_frames", 1)
                width, height = image.size
                if width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE:
                    raise FileProcessingError("image_dimensions_exceeded")
                if width * height > MAX_IMAGE_PIXELS:
                    raise FileProcessingError("image_pixel_limit_exceeded")
                image.seek(0)
                image.load()
                converted = image.convert("RGBA")
                output = BytesIO()
                # Re-encoding a fresh RGBA image removes EXIF/XMP/ICC and all
                # source container metadata rather than attempting a blacklist.
                converted.save(output, format="WEBP", quality=82, method=6, exact=True)
    except FileProcessingError:
        raise
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError):
        raise FileProcessingError("invalid_image") from None

    preview = output.getvalue()
    return ProcessedFile(
        format=policy.format.value,
        media_type=policy.media_type,
        kind="display_only",
        derivatives=(
            FileDerivative(role="original", content_type=policy.media_type, content=content),
            FileDerivative(role="preview", content_type=PREVIEW_MEDIA_TYPE, content=preview),
        ),
        warnings=(WARNING_ANIMATED_IMAGE_FIRST_FRAME,) if frame_count > 1 else (),
        metadata={
            "width": width,
            "height": height,
            "pixels": width * height,
            "frame_count": frame_count,
        },
        extractor_version="image-v1",
    )


def _parse_pdf(content: bytes, policy: FormatPolicy) -> ProcessedFile:
    if content.find(b"%PDF-") < 0 or content.find(b"%PDF-") > _PDF_HEADER_SEARCH_BYTES:
        raise FileProcessingError("invalid_pdf")
    try:
        reader = PdfReader(BytesIO(content), strict=False)
        if reader.is_encrypted:
            raise FileProcessingError("encrypted_document")
        page_count = len(reader.pages)
        if page_count > MAX_PDF_PAGES:
            return _display_only_processed(
                policy,
                source=content,
                warnings_out=(WARNING_COMPLEXITY_LIMIT,),
                metadata={"page_count": page_count},
                extractor_version="pdf-v1",
            )
    except FileProcessingError:
        raise
    except Exception:
        raise FileProcessingError("invalid_pdf") from None

    sections: list[str] = []
    partial = False
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            extracted = _normalize_newlines(page.extract_text() or "").strip()
        except Exception:
            partial = True
            continue
        if not extracted:
            partial = True
            continue
        sections.append(f"--- Page {page_number} ---\n{extracted}")
    if not sections:
        return _display_only_processed(
            policy,
            source=content,
            warnings_out=(WARNING_NO_EXTRACTABLE_TEXT,),
            metadata={"page_count": page_count, "extracted_page_count": 0},
            extractor_version="pdf-v1",
        )
    warnings_out = (WARNING_PARTIAL_CONTENT,) if partial else ()
    return _document_processed(
        policy,
        source=content,
        text="\n\n".join(sections),
        warnings_out=warnings_out,
        metadata={"page_count": page_count, "extracted_page_count": len(sections)},
        extractor_version="pdf-v1",
    )


@dataclass
class _OoxmlArchive:
    archive: zipfile.ZipFile
    names: frozenset[str]
    warnings: tuple[str, ...] = ()

    def read_xml(self, name: str) -> ElementTree.Element:
        if name not in self.names:
            raise FileProcessingError("invalid_ooxml")
        try:
            raw = self.archive.read(name)
        except (KeyError, OSError, RuntimeError, zipfile.BadZipFile):
            raise FileProcessingError("invalid_ooxml") from None
        if len(raw) > MAX_OOXML_XML_BYTES:
            raise FileProcessingError("ooxml_size_limit_exceeded")
        return _safe_xml(raw)

    def close(self) -> None:
        self.archive.close()


def _open_ooxml(content: bytes, expected_format: FileFormat) -> _OoxmlArchive:
    if content.startswith(_OLE_COMPOUND_FILE_MAGIC):
        # Encrypted OOXML is an OLE compound document containing
        # ``EncryptedPackage`` rather than a normal ZIP package.
        raise FileProcessingError("encrypted_document")
    try:
        archive = zipfile.ZipFile(BytesIO(content))
    except (OSError, zipfile.BadZipFile):
        raise FileProcessingError("invalid_ooxml") from None
    package = _OoxmlArchive(
        archive=archive,
        names=frozenset(info.filename for info in archive.infolist()),
    )
    try:
        package.warnings = _validate_ooxml_archive(package, expected_format)
    except BaseException:
        package.close()
        raise
    return package


def _validate_ooxml_archive(
    package: _OoxmlArchive,
    expected_format: FileFormat,
) -> tuple[str, ...]:
    infos = package.archive.infolist()
    warnings_out: list[str] = []
    if len(infos) > MAX_OOXML_ENTRIES:
        raise FileProcessingError("ooxml_entry_limit_exceeded")
    if len(package.names) != len(infos):
        raise FileProcessingError("invalid_ooxml")
    total_uncompressed = 0
    for info in infos:
        if _unsafe_archive_name(info.filename):
            raise FileProcessingError("unsafe_archive_path")
        if info.flag_bits & 0x1:
            raise FileProcessingError("encrypted_document")
        total_uncompressed += info.file_size
        if total_uncompressed > MAX_OOXML_UNCOMPRESSED_BYTES:
            raise FileProcessingError("ooxml_size_limit_exceeded")
        if (
            info.file_size
            and info.file_size > max(1, info.compress_size) * MAX_OOXML_COMPRESSION_RATIO
        ):
            raise FileProcessingError("ooxml_compression_ratio_exceeded")
        if not info.is_dir() and _looks_like_nested_archive(package.archive, info):
            warnings_out.append(WARNING_EMBEDDED_CONTENT)

    expected_content_type, expected_main_part = _CONTENT_TYPE_MAIN_PART[expected_format]
    types = package.read_xml("[Content_Types].xml")
    found_main_type = any(
        _local_name(element.tag) == "Override"
        and element.attrib.get("PartName") == f"/{expected_main_part}"
        and element.attrib.get("ContentType") == expected_content_type
        for element in types.iter()
    )
    if not found_main_type or expected_main_part not in package.names:
        raise FileProcessingError("ooxml_type_mismatch")

    for name in package.names:
        if name.endswith(".rels"):
            relationships = package.read_xml(name)
            for item in relationships.iter():
                if (
                    _local_name(item.tag) != "Relationship"
                    or item.attrib.get("TargetMode", "").casefold() != "external"
                ):
                    continue
                relationship_type = item.attrib.get("Type", "").rsplit("/", 1)[-1]
                if relationship_type.casefold() == "hyperlink":
                    warnings_out.append(WARNING_EXTERNAL_LINKS)
                    continue
                raise FileProcessingError("external_reference_not_allowed")
    if expected_format is FileFormat.XLSX and any(
        name.startswith("xl/externalLinks/") for name in package.names
    ):
        raise FileProcessingError("external_reference_not_allowed")
    return _merge_warnings(tuple(warnings_out))


def _unsafe_archive_name(name: str) -> bool:
    if not name or "\0" in name:
        return True
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    return (
        normalized.startswith("/")
        or bool(re.match(r"^[A-Za-z]:", normalized))
        or path.is_absolute()
        or ".." in path.parts
    )


def _looks_like_nested_archive(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bool:
    if PurePosixPath(info.filename).suffix.casefold() in _NESTED_ARCHIVE_SUFFIXES:
        return True
    try:
        with archive.open(info) as item:
            return item.read(4) == b"PK\x03\x04"
    except (OSError, RuntimeError, zipfile.BadZipFile):
        raise FileProcessingError("invalid_ooxml") from None


def _safe_xml(raw: bytes) -> ElementTree.Element:
    lowered = raw.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise FileProcessingError("unsafe_xml")
    try:
        return ElementTree.fromstring(raw)
    except ElementTree.ParseError:
        raise FileProcessingError("invalid_ooxml") from None


def _parse_docx(content: bytes, policy: FormatPolicy) -> ProcessedFile:
    package = _open_ooxml(content, FileFormat.DOCX)
    try:
        root = package.read_xml("word/document.xml")
        body = next((item for item in root.iter() if _local_name(item.tag) == "body"), None)
        if body is None:
            raise FileProcessingError("invalid_ooxml")
        blocks: list[str] = []
        node_count = 0
        for child in body:
            name = _local_name(child.tag)
            if name == "p":
                paragraph, count = _docx_visible_text(child)
                node_count += count
                if paragraph:
                    blocks.append(paragraph)
            elif name == "tbl":
                table_lines, count = _docx_table_text(child)
                node_count += count
                if table_lines:
                    blocks.append("\n".join(table_lines))
            if node_count > MAX_DOCX_NODES:
                return _display_only_processed(
                    policy,
                    source=content,
                    warnings_out=_merge_warnings(
                        package.warnings,
                        (WARNING_COMPLEXITY_LIMIT,),
                    ),
                    metadata={"extractable_nodes": node_count},
                    extractor_version="docx-v1",
                )
        text = "\n\n".join(blocks).strip()
        if not text:
            return _display_only_processed(
                policy,
                source=content,
                warnings_out=_merge_warnings(
                    package.warnings,
                    (WARNING_NO_EXTRACTABLE_TEXT,),
                ),
                metadata={"extractable_nodes": node_count},
                extractor_version="docx-v1",
            )
        has_visual_content = any(
            _local_name(item.tag) in {"drawing", "pict", "object"} for item in root.iter()
        ) or any(name.startswith("word/media/") for name in package.names)
        warnings_out = _merge_warnings(
            package.warnings,
            (WARNING_PARTIAL_CONTENT,) if has_visual_content else (),
        )
        return _document_processed(
            policy,
            source=content,
            text=text,
            warnings_out=warnings_out,
            metadata={"extractable_nodes": node_count},
            extractor_version="docx-v1",
        )
    finally:
        package.close()


def _docx_visible_text(element: ElementTree.Element) -> tuple[str, int]:
    parts: list[str] = []
    node_count = 0

    def visit(node: ElementTree.Element, *, hidden: bool = False, deleted: bool = False) -> None:
        nonlocal node_count
        name = _local_name(node.tag)
        node_deleted = deleted or name in {"del", "moveFrom"}
        node_hidden = hidden or (name == "r" and _docx_run_is_hidden(node))
        if name == "t" and not node_deleted and not node_hidden:
            node_count += 1
            parts.append(node.text or "")
            return
        if name == "tab" and not node_deleted and not node_hidden:
            parts.append("\t")
            return
        if name in {"br", "cr"} and not node_deleted and not node_hidden:
            parts.append("\n")
            return
        for child in node:
            visit(child, hidden=node_hidden, deleted=node_deleted)

    visit(element)
    return "".join(parts).strip(), node_count


def _docx_run_is_hidden(run: ElementTree.Element) -> bool:
    return any(
        _local_name(item.tag) in {"vanish", "webHidden", "specVanish"} for item in run.iter()
    )


def _docx_table_text(table: ElementTree.Element) -> tuple[list[str], int]:
    lines: list[str] = []
    node_count = 0
    for row in (item for item in table if _local_name(item.tag) == "tr"):
        cells: list[str] = []
        for cell in (item for item in row if _local_name(item.tag) == "tc"):
            paragraph_parts: list[str] = []
            for paragraph in (item for item in cell.iter() if _local_name(item.tag) == "p"):
                extracted, count = _docx_visible_text(paragraph)
                node_count += count
                if extracted:
                    paragraph_parts.append(extracted)
            cells.append(" ".join(paragraph_parts))
        if any(cells):
            escaped_cells = [cell.replace("|", "\\|").replace("\n", " ") for cell in cells]
            lines.append("| " + " | ".join(escaped_cells) + " |")
    return lines, node_count


def _parse_pptx(content: bytes, policy: FormatPolicy) -> ProcessedFile:
    package = _open_ooxml(content, FileFormat.PPTX)
    try:
        slide_paths = _pptx_visible_slide_paths(package)
        if len(slide_paths) > MAX_PPTX_VISIBLE_SLIDES:
            return _display_only_processed(
                policy,
                source=content,
                warnings_out=_merge_warnings(
                    package.warnings,
                    (WARNING_COMPLEXITY_LIMIT,),
                ),
                metadata={"visible_slide_count": len(slide_paths)},
                extractor_version="pptx-v1",
            )
        sections: list[str] = []
        partial = False
        for source_index, path in slide_paths:
            slide = package.read_xml(path)
            text, has_visual_content = _pptx_visible_text(slide)
            if not text:
                partial = True
                continue
            if has_visual_content:
                partial = True
            sections.append(f"--- Slide {source_index} ---\n{text}")
        if not sections:
            return _display_only_processed(
                policy,
                source=content,
                warnings_out=_merge_warnings(
                    package.warnings,
                    (WARNING_NO_EXTRACTABLE_TEXT,),
                ),
                metadata={
                    "visible_slide_count": len(slide_paths),
                    "extracted_slide_count": 0,
                },
                extractor_version="pptx-v1",
            )
        warnings_out = _merge_warnings(
            package.warnings,
            (WARNING_PARTIAL_CONTENT,) if partial else (),
        )
        return _document_processed(
            policy,
            source=content,
            text="\n\n".join(sections),
            warnings_out=warnings_out,
            metadata={
                "visible_slide_count": len(slide_paths),
                "extracted_slide_count": len(sections),
            },
            extractor_version="pptx-v1",
        )
    finally:
        package.close()


def _pptx_visible_slide_paths(package: _OoxmlArchive) -> list[tuple[int, str]]:
    presentation = package.read_xml("ppt/presentation.xml")
    relationships = _relationship_targets(package, "ppt/presentation.xml")
    slide_ids = [item for item in presentation.iter() if _local_name(item.tag) == "sldId"]
    paths: list[tuple[int, str]] = []
    for source_index, slide_id in enumerate(slide_ids, start=1):
        if _false_xml_value(slide_id.attrib.get("show")):
            continue
        relationship_id = slide_id.attrib.get(f"{{{_REL_NS}}}id") or slide_id.attrib.get("id")
        if not relationship_id or relationship_id not in relationships:
            raise FileProcessingError("invalid_ooxml")
        path = relationships[relationship_id]
        if path not in package.names:
            raise FileProcessingError("invalid_ooxml")
        paths.append((source_index, path))
    return paths


def _relationship_targets(package: _OoxmlArchive, source_part: str) -> dict[str, str]:
    parent = posixpath.dirname(source_part)
    relation_name = f"{parent}/_rels/{posixpath.basename(source_part)}.rels"
    relationships = package.read_xml(relation_name)
    targets: dict[str, str] = {}
    for relation in relationships.iter():
        if _local_name(relation.tag) != "Relationship":
            continue
        relationship_id = relation.attrib.get("Id")
        target = relation.attrib.get("Target")
        if not relationship_id or not target:
            raise FileProcessingError("invalid_ooxml")
        targets[relationship_id] = _resolve_part_target(source_part, target)
    return targets


def _resolve_part_target(source_part: str, target: str) -> str:
    if target.startswith("/") or target.startswith("\\") or "\0" in target:
        raise FileProcessingError("unsafe_archive_path")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))
    if resolved.startswith("../") or resolved == ".." or resolved.startswith("/"):
        raise FileProcessingError("unsafe_archive_path")
    return resolved


def _pptx_visible_text(slide: ElementTree.Element) -> tuple[str, bool]:
    parents = {child: parent for parent in slide.iter() for child in parent}
    lines: list[str] = []
    for paragraph in slide.iter():
        if paragraph.tag != f"{{{_DRAWING_NS}}}p" or _hidden_by_ancestor(paragraph, parents):
            continue
        fragments = [
            item.text or ""
            for item in paragraph.iter()
            if item.tag == f"{{{_DRAWING_NS}}}t" and not _hidden_by_ancestor(item, parents)
        ]
        line = "".join(fragments).strip()
        if line:
            lines.append(line)
    has_visual_content = any(
        _local_name(item.tag) in {"pic", "graphicFrame", "oleObj", "videoFile", "audioFile"}
        and not _hidden_by_ancestor(item, parents)
        for item in slide.iter()
    )
    return "\n".join(lines), has_visual_content


def _hidden_by_ancestor(
    element: ElementTree.Element,
    parents: dict[ElementTree.Element, ElementTree.Element],
) -> bool:
    current: ElementTree.Element | None = element
    while current is not None:
        for key, value in current.attrib.items():
            if (
                (_local_name(key) == "hidden" and _true_xml_value(value))
                or (_local_name(key) == "show" and _false_xml_value(value))
            ):
                return True
        current = parents.get(current)
    return False


def _parse_xlsx(content: bytes, policy: FormatPolicy) -> ProcessedFile:
    package = _open_ooxml(content, FileFormat.XLSX)
    try:
        workbook = package.read_xml("xl/workbook.xml")
        relationships = _relationship_targets(package, "xl/workbook.xml")
        shared_strings = _xlsx_shared_strings(package)
        date_styles = _xlsx_date_styles(package)
        workbook_properties = next(
            (item for item in workbook.iter() if _local_name(item.tag) == "workbookPr"),
            None,
        )
        date_1904 = workbook_properties is not None and _true_xml_value(
            workbook_properties.attrib.get("date1904")
        )
        sheets = [item for item in workbook.iter() if _local_name(item.tag) == "sheet"]
        visible_sheets: list[tuple[str, str]] = []
        hidden_sheet_count = 0
        for sheet in sheets:
            if _false_xml_value(sheet.attrib.get("state")) or sheet.attrib.get("state") in {
                "hidden",
                "veryHidden",
            }:
                hidden_sheet_count += 1
                continue
            name = sheet.attrib.get("name")
            relationship_id = sheet.attrib.get(f"{{{_REL_NS}}}id")
            if not name or not relationship_id or relationship_id not in relationships:
                raise FileProcessingError("invalid_ooxml")
            path = relationships[relationship_id]
            if path not in package.names:
                raise FileProcessingError("invalid_ooxml")
            visible_sheets.append((name, path))
        if len(visible_sheets) > MAX_XLSX_VISIBLE_SHEETS:
            return _display_only_processed(
                policy,
                source=content,
                warnings_out=_merge_warnings(
                    package.warnings,
                    (WARNING_COMPLEXITY_LIMIT,),
                ),
                metadata={
                    "visible_sheet_count": len(visible_sheets),
                    "hidden_sheet_count": hidden_sheet_count,
                },
                extractor_version="xlsx-v1",
            )

        sections: list[str] = []
        cell_count = 0
        partial = hidden_sheet_count > 0
        for sheet_name, path in visible_sheets:
            worksheet = package.read_xml(path)
            try:
                rows, sheet_partial = _xlsx_visible_cells(
                    worksheet,
                    shared_strings=shared_strings,
                    date_styles=date_styles,
                    date_1904=date_1904,
                    current_count=cell_count,
                )
            except FileProcessingError as error:
                if error.code != "cell_limit_exceeded":
                    raise
                return _display_only_processed(
                    policy,
                    source=content,
                    warnings_out=_merge_warnings(
                        package.warnings,
                        (WARNING_COMPLEXITY_LIMIT,),
                    ),
                    metadata={
                        "visible_sheet_count": len(visible_sheets),
                        "hidden_sheet_count": hidden_sheet_count,
                        "cell_count": cell_count,
                    },
                    extractor_version="xlsx-v1",
                )
            cell_count += len(rows)
            if cell_count > MAX_XLSX_NONEMPTY_CELLS:
                raise FileProcessingError("cell_limit_exceeded")
            partial = partial or sheet_partial
            if rows:
                sections.append(f"--- Sheet: {sheet_name} ---\n" + "\n".join(rows))
        if not sections:
            return _display_only_processed(
                policy,
                source=content,
                warnings_out=_merge_warnings(
                    package.warnings,
                    (WARNING_NO_EXTRACTABLE_TEXT,),
                ),
                metadata={
                    "visible_sheet_count": len(visible_sheets),
                    "hidden_sheet_count": hidden_sheet_count,
                    "cell_count": cell_count,
                },
                extractor_version="xlsx-v1",
            )
        warnings_out = _merge_warnings(
            package.warnings,
            (WARNING_PARTIAL_CONTENT,) if partial else (),
        )
        return _document_processed(
            policy,
            source=content,
            text="\n\n".join(sections),
            warnings_out=warnings_out,
            metadata={
                "visible_sheet_count": len(visible_sheets),
                "hidden_sheet_count": hidden_sheet_count,
                "cell_count": cell_count,
            },
            extractor_version="xlsx-v1",
        )
    finally:
        package.close()


def _xlsx_shared_strings(package: _OoxmlArchive) -> list[str]:
    if "xl/sharedStrings.xml" not in package.names:
        return []
    root = package.read_xml("xl/sharedStrings.xml")
    return [
        "".join(item.text or "" for item in shared.iter() if _local_name(item.tag) == "t")
        for shared in root.iter()
        if _local_name(shared.tag) == "si"
    ]


def _xlsx_date_styles(package: _OoxmlArchive) -> set[int]:
    if "xl/styles.xml" not in package.names:
        return set()
    root = package.read_xml("xl/styles.xml")
    custom_formats = {
        int(item.attrib["numFmtId"]): item.attrib.get("formatCode", "")
        for item in root.iter()
        if _local_name(item.tag) == "numFmt" and item.attrib.get("numFmtId", "").isdigit()
    }
    date_styles: set[int] = set()
    cell_xfs = next((item for item in root.iter() if _local_name(item.tag) == "cellXfs"), None)
    if cell_xfs is None:
        return date_styles
    for index, xf in enumerate(item for item in cell_xfs if _local_name(item.tag) == "xf"):
        number_format = xf.attrib.get("numFmtId", "0")
        if not number_format.isdigit():
            continue
        format_id = int(number_format)
        if format_id in _BUILTIN_DATE_FORMAT_IDS or _looks_like_excel_date(
            custom_formats.get(format_id, "")
        ):
            date_styles.add(index)
    return date_styles


_BUILTIN_DATE_FORMAT_IDS = frozenset({14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47})


def _looks_like_excel_date(number_format: str) -> bool:
    without_literals = re.sub(r'"[^"]*"|\\.', "", number_format.casefold())
    return bool(re.search(r"[ymdhis]", without_literals))


def _xlsx_visible_cells(
    worksheet: ElementTree.Element,
    *,
    shared_strings: list[str],
    date_styles: set[int],
    date_1904: bool,
    current_count: int,
) -> tuple[list[str], bool]:
    hidden_columns = _xlsx_hidden_columns(worksheet)
    rows: list[str] = []
    partial = bool(hidden_columns)
    count = current_count
    for row in (item for item in worksheet.iter() if _local_name(item.tag) == "row"):
        row_hidden = _true_xml_value(row.attrib.get("hidden"))
        partial = partial or row_hidden
        for cell in (item for item in row if _local_name(item.tag) == "c"):
            reference = cell.attrib.get("r")
            if reference is None:
                raise FileProcessingError("invalid_ooxml")
            column_index = _column_index(reference)
            if row_hidden or _column_is_hidden(column_index, hidden_columns):
                continue
            value = _xlsx_cell_value(
                cell,
                shared_strings=shared_strings,
                date_styles=date_styles,
                date_1904=date_1904,
            )
            if value is None:
                continue
            count += 1
            if count > MAX_XLSX_NONEMPTY_CELLS:
                raise FileProcessingError("cell_limit_exceeded")
            rows.append(f"{reference}: {value}")
    return rows, partial


def _xlsx_hidden_columns(worksheet: ElementTree.Element) -> tuple[tuple[int, int], ...]:
    ranges: list[tuple[int, int]] = []
    for column in (item for item in worksheet.iter() if _local_name(item.tag) == "col"):
        if not _true_xml_value(column.attrib.get("hidden")):
            continue
        lower = column.attrib.get("min")
        upper = column.attrib.get("max")
        if lower is None or upper is None or not lower.isdigit() or not upper.isdigit():
            raise FileProcessingError("invalid_ooxml")
        start, end = int(lower), int(upper)
        if start < 1 or end < start:
            raise FileProcessingError("invalid_ooxml")
        ranges.append((start, end))
    merged: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return tuple(merged)


def _column_is_hidden(column_index: int, hidden_columns: tuple[tuple[int, int], ...]) -> bool:
    return any(start <= column_index <= end for start, end in hidden_columns)


def _column_index(reference: str) -> int:
    match = _CELL_REFERENCE_RE.fullmatch(reference)
    if match is None:
        raise FileProcessingError("invalid_ooxml")
    value = 0
    for character in match.group(1).upper():
        value = value * 26 + ord(character) - ord("A") + 1
    return value


def _xlsx_cell_value(
    cell: ElementTree.Element,
    *,
    shared_strings: list[str],
    date_styles: set[int],
    date_1904: bool,
) -> str | None:
    cell_type = cell.attrib.get("t")
    formula = next((item for item in cell if _local_name(item.tag) == "f"), None)
    raw_value = next((item.text for item in cell if _local_name(item.tag) == "v"), None)
    if formula is not None:
        formula_text = formula.text or ""
        formula_value = formula_text if formula_text.startswith("=") else f"={formula_text}"
        cached = _xlsx_raw_cell_value(
            cell_type,
            raw_value,
            cell=cell,
            shared_strings=shared_strings,
            date_styles=date_styles,
            date_1904=date_1904,
        )
        return f"{formula_value} (cached: {cached})" if cached is not None else formula_value
    return _xlsx_raw_cell_value(
        cell_type,
        raw_value,
        cell=cell,
        shared_strings=shared_strings,
        date_styles=date_styles,
        date_1904=date_1904,
    )


def _xlsx_raw_cell_value(
    cell_type: str | None,
    raw_value: str | None,
    *,
    cell: ElementTree.Element,
    shared_strings: list[str],
    date_styles: set[int],
    date_1904: bool,
) -> str | None:
    if cell_type == "inlineStr":
        value = "".join(item.text or "" for item in cell.iter() if _local_name(item.tag) == "t")
        return value if value else None
    if raw_value is None:
        return None
    if cell_type == "s":
        try:
            index = int(raw_value)
            return shared_strings[index]
        except (IndexError, ValueError):
            raise FileProcessingError("invalid_ooxml") from None
    if cell_type == "b":
        return "TRUE" if raw_value == "1" else "FALSE" if raw_value == "0" else raw_value
    if cell_type == "d":
        return raw_value
    style = cell.attrib.get("s")
    if style is not None and style.isdigit() and int(style) in date_styles:
        return _excel_date_value(raw_value, date_1904=date_1904)
    return raw_value


def _excel_date_value(value: str, *, date_1904: bool) -> str:
    try:
        serial = float(value)
        if date_1904:
            base = datetime(1904, 1, 1)
        else:
            base = datetime(1899, 12, 31)
            # Excel preserves the historic fictitious 1900-02-29 at serial 60.
            # Python cannot represent it, so match common spreadsheet readers
            # by mapping 60 to 1900-02-28 and shifting all later serials back.
            if serial >= 60:
                serial -= 1
        converted = base + timedelta(days=serial)
    except (OverflowError, ValueError):
        return value
    return converted.date().isoformat() if serial.is_integer() else converted.isoformat(sep=" ")


def _document_processed(
    policy: FormatPolicy,
    *,
    source: bytes,
    text: str,
    warnings_out: tuple[str, ...] = (),
    metadata: dict[str, int | str | bool],
    extractor_version: str,
) -> ProcessedFile:
    return ProcessedFile(
        format=policy.format.value,
        media_type=policy.media_type,
        kind="document",
        derivatives=(
            FileDerivative(role="original", content_type=policy.media_type, content=source),
            FileDerivative(
                role="document_extract",
                content_type=DOCUMENT_EXTRACT_MEDIA_TYPE,
                content=text.encode("utf-8"),
            ),
        ),
        warnings=warnings_out,
        metadata=metadata,
        extractor_version=extractor_version,
    )


def _display_only_processed(
    policy: FormatPolicy,
    *,
    source: bytes,
    warnings_out: tuple[str, ...],
    metadata: dict[str, int | str | bool],
    extractor_version: str,
) -> ProcessedFile:
    return ProcessedFile(
        format=policy.format.value,
        media_type=policy.media_type,
        kind="display_only",
        derivatives=(
            FileDerivative(role="original", content_type=policy.media_type, content=source),
        ),
        warnings=warnings_out,
        metadata=metadata,
        extractor_version=extractor_version,
    )


def _merge_warnings(*groups: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item for group in groups for item in group))


def _local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def _false_xml_value(value: str | None) -> bool:
    return value is not None and value.casefold() in {"0", "false", "off"}


def _true_xml_value(value: str | None) -> bool:
    return value is not None and value.casefold() in {"1", "true", "on"}
