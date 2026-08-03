"""Credential-free subprocess entry point for untrusted file parsers."""

from __future__ import annotations

import ctypes
import json
import os
import signal
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.files.protocols import ProcessedFile

_PARENT_DEATH_SIGNAL = getattr(signal, "SIGKILL", signal.SIGTERM)


def _terminate_if_parent_dies(expected_parent_pid: int) -> None:
    """Make Linux kill this parser if its Celery worker is hard-killed."""

    if not sys.platform.startswith("linux"):
        return
    if os.getppid() != expected_parent_pid:
        os.kill(os.getpid(), _PARENT_DEATH_SIGNAL)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, _PARENT_DEATH_SIGNAL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")
    # Close the race where the parent exits between getppid() and prctl().
    if os.getppid() != expected_parent_pid:
        os.kill(os.getpid(), _PARENT_DEATH_SIGNAL)


def _write_result(output_directory: Path, payload: dict[str, object]) -> None:
    temporary = output_directory / "result.tmp"
    final = output_directory / "result.json"
    data = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
    os.replace(temporary, final)


def _success_payload(output_directory: Path, processed: ProcessedFile) -> dict[str, object]:
    derivatives: list[dict[str, object]] = []
    for index, derivative in enumerate(processed.derivatives):
        row: dict[str, object] = {
            "role": derivative.role,
            "content_type": derivative.content_type,
            "size_bytes": derivative.size_bytes,
            "sha256": derivative.sha256_hex,
        }
        if derivative.role == "original":
            row["source"] = True
        else:
            filename = f"derivative-{index}.bin"
            path = output_directory / filename
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(derivative.content)
            row["file"] = filename
        derivatives.append(row)
    return {
        "outcome": "ok",
        "format": processed.format,
        "media_type": processed.media_type,
        "kind": processed.kind,
        "warnings": list(processed.warnings),
        "metadata": dict(processed.metadata),
        "extractor_version": processed.extractor_version,
        "derivatives": derivatives,
    }


def main(argv: list[str] | None = None) -> int:
    arguments = argv or sys.argv
    if len(arguments) != 6:
        return 2
    try:
        _terminate_if_parent_dies(int(arguments[5]))
    except BaseException:
        return 4

    # Import untrusted parser dependencies only after the Linux parent-death
    # contract is armed, closing the fork/exec-to-import orphan window.
    from app.services.files.formats import policy_for_format
    from app.services.files.parsers import _apply_child_limits, parse_file
    from app.services.files.protocols import FileProcessingError

    try:
        policy = policy_for_format(arguments[1])
        output_directory = Path(arguments[2]).resolve(strict=True)
        timeout_seconds = float(arguments[3])
        raw_memory_limit = int(arguments[4])
        memory_limit = raw_memory_limit or None
        _apply_child_limits(
            timeout_seconds=timeout_seconds,
            memory_limit_bytes=memory_limit,
        )
        content = sys.stdin.buffer.read(policy.max_bytes + 1)
        if len(content) > policy.max_bytes:
            raise FileProcessingError("file_too_large")
        processed = parse_file(content, policy)
        payload = _success_payload(output_directory, processed)
    except FileProcessingError as error:
        payload = {
            "outcome": "error",
            "code": error.code,
            "retryable": error.retryable,
        }
    except BaseException:
        payload = {"outcome": "error", "code": "parser_failed", "retryable": False}
    try:
        _write_result(output_directory, payload)
    except BaseException:
        return 3
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through the parent seam.
    raise SystemExit(main())
