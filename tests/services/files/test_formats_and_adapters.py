from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
from io import BytesIO
from threading import Barrier

import pytest

from app.services.files.formats import (
    IMAGE_MAX_BYTES,
    FileFormat,
    policy_for_filename,
    validate_upload_declaration,
)
from app.services.files.protocols import CompletedPart, FileProcessingError, ScanVerdict
from app.services.files.scanner import (
    ClamAvScanner,
    FakeMalwareScanner,
    ScannerSignaturesStale,
    ScannerUnavailable,
    require_clean,
)
from app.services.files.storage import (
    FakeFileStorage,
    R2FileStorage,
    S3FileStorage,
    StoragePermissionDenied,
    StoragePreconditionFailed,
    safe_content_disposition,
)


class _RangeGetClient:
    def __init__(self, content: bytes, *, workers: int) -> None:
        self.content = content
        self.calls: list[dict[str, object]] = []
        self.barrier = Barrier(workers, timeout=1)

    def get_object(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        byte_range = str(kwargs["Range"])
        start_text, end_text = byte_range.removeprefix("bytes=").split("-", 1)
        self.barrier.wait()
        start, end = int(start_text), int(end_text)
        return {"Body": BytesIO(self.content[start : end + 1])}


class _SingleGetClient:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.calls: list[dict[str, object]] = []

    def get_object(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {"Body": BytesIO(self.content)}


def test_format_policy_is_extension_controlled_and_checks_size() -> None:
    assert policy_for_filename("report.YML").format is FileFormat.YAML
    assert policy_for_filename("photo.jpeg").format is FileFormat.JPG
    assert validate_upload_declaration(
        filename="source.ts",
        content_type="text/plain; charset=utf-8",
        size_bytes=1,
    ).format is FileFormat.TS

    assert validate_upload_declaration(
        filename="photo.png",
        content_type="application/pdf",
        size_bytes=1,
    ).format is FileFormat.PNG
    with pytest.raises(FileProcessingError, match="file_too_large"):
        validate_upload_declaration(
            filename="photo.png",
            content_type="image/png",
            size_bytes=IMAGE_MAX_BYTES + 1,
        )


@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        ("source.py", "text/x-python-script"),
        ("source.go", "text/x-go-source"),
        ("source.ts", "video/mp2t"),
        ("query.sql", "application/x-sql"),
        ("table.csv", "application/vnd.ms-excel"),
        ("photo.webp", "application/octet-stream"),
        ("slides.pptx", "application/octet-stream"),
    ],
)
def test_format_policy_accepts_platform_specific_browser_mime_types(
    filename: str,
    content_type: str,
) -> None:
    assert validate_upload_declaration(
        filename=filename,
        content_type=content_type,
        size_bytes=1,
    ) is policy_for_filename(filename)


@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        ("source.py", "image/png"),
        ("photo.png", "application/pdf"),
        ("paper.pdf", "text/plain"),
    ],
)
def test_format_policy_treats_conflicting_browser_mime_types_as_untrusted_hints(
    filename: str,
    content_type: str,
) -> None:
    assert validate_upload_declaration(
        filename=filename,
        content_type=content_type,
        size_bytes=1,
    ) is policy_for_filename(filename)


def test_fake_storage_enforces_staging_etag_and_safe_download_headers() -> None:
    storage = FakeFileStorage()
    etag = storage.put_staging(
        "staging/object", b"source", content_type="text/plain", declared_size_bytes=6
    )
    assert storage.head_staging("staging/object").etag == etag
    assert storage.get_staging("staging/object", if_match=etag) == b"source"
    with pytest.raises(StoragePreconditionFailed):
        storage.get_staging("staging/object", if_match="changed")

    storage.put_canonical("files/object/original", content=b"source", content_type="text/plain")
    signed = storage.presign_download(
        "files/object/original",
        ttl_seconds=300,
        disposition="attachment",
        filename='../unsafe\r\n"name.txt',
    )
    assert signed.headers["Content-Disposition"].startswith("attachment;")
    assert "\r" not in signed.headers["Content-Disposition"]
    assert "\n" not in signed.headers["Content-Disposition"]
    assert "../" not in signed.headers["Content-Disposition"]
    assert "filename*=UTF-8''" in safe_content_disposition("inline", "中文.png")


def test_fake_storage_completes_multipart_and_promotes_original_without_reupload() -> None:
    storage = FakeFileStorage()
    plan = storage.create_multipart_upload(
        "staging/object",
        size_bytes=6,
        part_size_bytes=5 * 1024 * 1024,
        ttl_seconds=600,
        content_type="text/plain",
    )
    etag = storage.put_multipart_part(plan.upload_id, 1, b"source")
    staged = storage.complete_multipart_upload(
        "staging/object",
        upload_id=plan.upload_id,
        parts=(CompletedPart(part_number=1, etag=etag),),
    )

    storage.promote_staging_original(
        "staging/object",
        "files/object/original",
        if_match=staged.etag,
        expected_size_bytes=6,
        expected_sha256=sha256(b"source").hexdigest(),
        content_type="text/plain",
    )

    assert storage.canonical["files/object/original"].content == b"source"
    assert storage.promoted_originals == [("staging/object", "files/object/original")]


def test_s3_storage_downloads_large_staging_objects_with_parallel_conditional_ranges() -> None:
    content = b"0123456789"
    client = _RangeGetClient(content, workers=3)
    storage = S3FileStorage(
        client,
        staging_bucket="staging",
        canonical_bucket="canonical",
        parallel_download_threshold_bytes=8,
        parallel_download_max_concurrency=3,
    )

    result = storage.get_staging(
        "staging/object",
        if_match="etag",
        expected_size_bytes=len(content),
    )

    assert result == content
    assert {str(call["Range"]) for call in client.calls} == {
        "bytes=0-3",
        "bytes=4-7",
        "bytes=8-9",
    }
    assert {str(call["IfMatch"]) for call in client.calls} == {'"etag"'}


def test_s3_storage_keeps_small_staging_downloads_as_a_single_request() -> None:
    content = b"source"
    client = _SingleGetClient(content)
    storage = S3FileStorage(
        client,
        staging_bucket="staging",
        canonical_bucket="canonical",
        parallel_download_threshold_bytes=8,
        parallel_download_max_concurrency=3,
    )

    result = storage.get_staging(
        "staging/object",
        if_match="etag",
        expected_size_bytes=len(content),
    )

    assert result == content
    assert len(client.calls) == 1
    assert "Range" not in client.calls[0]
    assert client.calls[0]["IfMatch"] == '"etag"'


def test_r2_adapter_role_gates_operations_before_the_sdk_client_is_used() -> None:
    storage = R2FileStorage(
        object(),
        staging_bucket="staging",
        canonical_bucket="canonical",
        credential_role="download",
    )
    with pytest.raises(StoragePermissionDenied):
        storage.put_canonical("files/object/original", content=b"x", content_type="text/plain")


def test_scanner_fake_and_clean_requirement_are_fail_closed() -> None:
    scanner = FakeMalwareScanner()
    assert scanner.scan(b"safe") is ScanVerdict.CLEAN
    assert scanner.scanned_sizes == [4]
    with pytest.raises(FileProcessingError, match="malware_detected"):
        require_clean(ScanVerdict.INFECTED)
    with pytest.raises(ScannerUnavailable, match="scanner_unavailable"):
        FakeMalwareScanner(failure=ScannerUnavailable()).scan(b"safe")


class _SocketScript:
    def __init__(self, responses: list[bytes]) -> None:
        self._responses = responses
        self.sent: list[bytes] = []

    def __enter__(self) -> _SocketScript:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def settimeout(self, _: float) -> None:
        return None

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def recv(self, _: int) -> bytes:
        return self._responses.pop(0) if self._responses else b""


def test_clamd_signature_version_is_cached_when_fresh() -> None:
    version = _SocketScript([b"ClamAV 1.0/123/Fri Aug 01 00:00:00 2026\0"])
    first_scan = _SocketScript([b"stream: OK\0"])
    second_scan = _SocketScript([b"stream: OK\0"])
    scripts = iter((version, first_scan, second_scan))
    scanner = ClamAvScanner(
        signature_max_age_seconds=60,
        signature_check_ttl_seconds=30,
        now=lambda: datetime(2026, 8, 1, 0, 0, 10, tzinfo=UTC),
        connection_factory=lambda: next(scripts),  # type: ignore[arg-type]
    )

    assert scanner.scan(b"first") is ScanVerdict.CLEAN
    assert scanner.scan(b"second") is ScanVerdict.CLEAN
    assert version.sent == [b"zVERSION\0"]
    assert first_scan.sent[0] == b"zINSTREAM\0"
    assert second_scan.sent[0] == b"zINSTREAM\0"


def test_clamd_signature_stale_or_unavailable_is_fail_closed() -> None:
    stale = _SocketScript([b"ClamAV 1.0/123/Thu Jul 30 00:00:00 2026\0"])
    scanner = ClamAvScanner(
        signature_max_age_seconds=60,
        now=lambda: datetime(2026, 8, 1, tzinfo=UTC),
        connection_factory=lambda: stale,  # type: ignore[arg-type]
    )
    with pytest.raises(ScannerSignaturesStale, match="scanner_signatures_stale"):
        scanner.scan(b"safe")

    def unavailable() -> object:
        raise OSError

    unavailable_scanner = ClamAvScanner(
        now=lambda: datetime(2026, 8, 1, tzinfo=UTC),
        connection_factory=unavailable,  # type: ignore[arg-type]
    )
    with pytest.raises(ScannerUnavailable, match="scanner_unavailable"):
        unavailable_scanner.scan(b"safe")
