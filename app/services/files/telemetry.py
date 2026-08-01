"""Structured, content-free telemetry helpers for the files domain.

The deployment currently derives metrics from JSON logs rather than exposing
an in-process Prometheus registry (Celery workers are separate processes).  A
single event vocabulary keeps phase latency and failures aggregatable without
ever logging filenames, object keys, signed URLs, document text, or parser
exceptions.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from time import perf_counter
from typing import Literal

from loguru import logger

from app.services.files.protocols import FileProcessingError

FilePhase = Literal[
    "queue_wait",
    "if_match_get",
    "clamav",
    "parse",
    "manifest_commit",
    "r2_write",
    "final_commit",
    "staging_cleanup",
    "object_delete",
    "cdn_purge",
]


def emit_file_phase(
    phase: FilePhase,
    *,
    outcome: Literal["succeeded", "failed"],
    duration_seconds: float,
    upload_id: str | None = None,
    deletion_id: int | None = None,
    error_code: str | None = None,
) -> None:
    """Emit one bounded metric event containing only internal identifiers."""

    logger.bind(
        metric="files_phase_seconds",
        phase=phase,
        outcome=outcome,
        value=max(duration_seconds, 0.0),
        upload_id=upload_id,
        deletion_id=deletion_id,
        error_code=error_code,
    ).info("Files phase metric")


@contextmanager
def observe_file_phase(
    phase: FilePhase,
    *,
    upload_id: str | None = None,
    deletion_id: int | None = None,
) -> Iterator[None]:
    """Time a phase and collapse errors to a stable, non-sensitive label."""

    started = perf_counter()
    try:
        yield
    except FileProcessingError as exc:
        emit_file_phase(
            phase,
            outcome="failed",
            duration_seconds=perf_counter() - started,
            upload_id=upload_id,
            deletion_id=deletion_id,
            error_code=exc.code,
        )
        raise
    except Exception:
        emit_file_phase(
            phase,
            outcome="failed",
            duration_seconds=perf_counter() - started,
            upload_id=upload_id,
            deletion_id=deletion_id,
            error_code="unexpected_error",
        )
        raise
    else:
        emit_file_phase(
            phase,
            outcome="succeeded",
            duration_seconds=perf_counter() - started,
            upload_id=upload_id,
            deletion_id=deletion_id,
        )


def emit_file_measure(
    metric: str,
    value: int | float,
    *,
    upload_id: str | None = None,
    user_id: int | None = None,
) -> None:
    """Emit an instantaneous gauge/counter sample using a stable metric name."""

    logger.bind(
        metric=metric,
        value=value,
        upload_id=upload_id,
        user_id=user_id,
    ).info("Files metric")
