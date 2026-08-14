"""Fail-closed ClamAV adapter used before any parser sees user bytes."""

from __future__ import annotations

import socket
import struct
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

from app.services.files.protocols import FileProcessingError, ScanVerdict


class ScannerUnavailable(FileProcessingError):
    def __init__(self) -> None:
        super().__init__("scanner_unavailable", retryable=True)


class ScannerSignaturesStale(FileProcessingError):
    """clamd is reachable, but its malware database is too old to trust."""

    def __init__(self) -> None:
        super().__init__("scanner_signatures_stale", retryable=True)


def require_clean(verdict: ScanVerdict) -> None:
    """Turn an infected result into a permanent, content-free rejection."""

    if verdict is ScanVerdict.INFECTED:
        raise FileProcessingError("malware_detected")


class ClamAvScanner:
    """Minimal clamd INSTREAM client with no fail-open path.

    A scanner response is deliberately collapsed to clean/infected.  In
    particular, malware signatures and clamd error details never leave this
    adapter, so an accidental log call cannot expose them.
    """

    def __init__(
        self,
        *,
        unix_socket: str | Path | None = None,
        host: str = "127.0.0.1",
        port: int = 3310,
        timeout_seconds: float = 10.0,
        chunk_size: int = 1024 * 1024,
        signature_max_age_seconds: int = 48 * 3_600,
        signature_check_ttl_seconds: float = 60.0,
        now: Callable[[], datetime] | None = None,
        connection_factory: Callable[[], socket.socket] | None = None,
    ) -> None:
        if unix_socket is None and not host:
            raise ValueError("a clamd endpoint is required")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        if signature_max_age_seconds <= 0:
            raise ValueError("signature_max_age_seconds must be positive")
        if signature_check_ttl_seconds < 0:
            raise ValueError("signature_check_ttl_seconds must not be negative")
        self._unix_socket = str(unix_socket) if unix_socket is not None else None
        self._host = host
        self._port = port
        self._timeout_seconds = timeout_seconds
        self._chunk_size = chunk_size
        self._signature_max_age = timedelta(seconds=signature_max_age_seconds)
        self._signature_check_ttl = timedelta(seconds=signature_check_ttl_seconds)
        self._now = now or _utc_now
        self._connection_factory = connection_factory
        self._signature_checked_at: datetime | None = None
        self._signature_timestamp: datetime | None = None

    def scan(self, content: bytes) -> ScanVerdict:
        self._require_fresh_signatures()
        try:
            with self._connect() as connection:
                connection.settimeout(self._timeout_seconds)
                connection.sendall(b"zINSTREAM\0")
                for start in range(0, len(content), self._chunk_size):
                    chunk = content[start : start + self._chunk_size]
                    connection.sendall(struct.pack("!I", len(chunk)))
                    connection.sendall(chunk)
                connection.sendall(struct.pack("!I", 0))
                response = _read_clamd_response(connection)
        except (OSError, TimeoutError):
            raise ScannerUnavailable from None

        # clamd's exact prefix contains a generated stream name; only the
        # suffix is stable enough for this narrow protocol.
        if response.endswith(b" OK"):
            return ScanVerdict.CLEAN
        if response.endswith(b" FOUND"):
            return ScanVerdict.INFECTED
        raise ScannerUnavailable

    @property
    def signature_age_seconds(self) -> float | None:
        """Age of the last verified database, for content-free telemetry."""

        if self._signature_timestamp is None:
            return None
        return max(
            0.0,
            (_as_utc(self._now()) - self._signature_timestamp).total_seconds(),
        )

    def _require_fresh_signatures(self) -> None:
        moment = _as_utc(self._now())
        cached_timestamp = self._signature_timestamp
        checked_at = self._signature_checked_at
        if (
            cached_timestamp is not None
            and checked_at is not None
            and moment - checked_at <= self._signature_check_ttl
        ):
            _require_signature_age(cached_timestamp, moment, self._signature_max_age)
            return
        try:
            with self._connect() as connection:
                connection.settimeout(self._timeout_seconds)
                connection.sendall(b"zVERSION\0")
                response = _read_clamd_response(connection)
        except (OSError, TimeoutError):
            raise ScannerUnavailable from None
        signature_timestamp = _parse_signature_timestamp(response)
        if signature_timestamp is None:
            raise ScannerUnavailable
        _require_signature_age(signature_timestamp, moment, self._signature_max_age)
        self._signature_timestamp = signature_timestamp
        self._signature_checked_at = moment

    def _connect(self) -> socket.socket:
        if self._connection_factory is not None:
            return self._connection_factory()
        if self._unix_socket is not None:
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.settimeout(self._timeout_seconds)
            connection.connect(self._unix_socket)
            return connection
        return socket.create_connection((self._host, self._port), timeout=self._timeout_seconds)


def _read_clamd_response(connection: socket.socket) -> bytes:
    chunks: list[bytes] = []
    while True:
        chunk = connection.recv(4096)
        if not chunk:
            break
        chunks.append(chunk)
        if b"\0" in chunk or b"\n" in chunk:
            break
    return b"".join(chunks).rstrip(b"\0\r\n")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _parse_signature_timestamp(response: bytes) -> datetime | None:
    """Parse the final ``VERSION`` slash field without exposing it to callers."""

    try:
        candidate = response.decode("ascii", errors="strict").rsplit("/", 1)[-1].strip()
    except UnicodeDecodeError:
        return None
    if not candidate:
        return None
    try:
        parsed = parsedate_to_datetime(candidate)
    except (IndexError, TypeError, ValueError):
        parsed = None
    if parsed is not None:
        return _as_utc(parsed)
    for pattern in ("%a %b %d %H:%M:%S %Y", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(candidate, pattern).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def _require_signature_age(
    signature_timestamp: datetime,
    moment: datetime,
    maximum_age: timedelta,
) -> None:
    age = moment - signature_timestamp
    # A substantially future timestamp also means the host/database clocks
    # cannot establish a trustworthy age, so it is fail-closed as well.
    if age < timedelta(0) or age > maximum_age:
        raise ScannerSignaturesStale


class FakeMalwareScanner:
    """Ordinary-CI scanner fake which retains neither names nor source bytes."""

    def __init__(
        self,
        verdict: ScanVerdict = ScanVerdict.CLEAN,
        *,
        failure: Exception | None = None,
        matcher: Callable[[bytes], ScanVerdict] | None = None,
    ) -> None:
        self.verdict = verdict
        self.failure = failure
        self.matcher = matcher
        self.scan_count = 0
        self.scanned_sizes: list[int] = []

    def scan(self, content: bytes) -> ScanVerdict:
        self.scan_count += 1
        self.scanned_sizes.append(len(content))
        if self.failure is not None:
            raise self.failure
        if self.matcher is not None:
            return self.matcher(content)
        return self.verdict


FakeClamAvScanner = FakeMalwareScanner
