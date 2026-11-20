"""Cloud drive adapter protocol (spec §5.1).

Business code depends only on this narrow interface. Adapters are
synchronous because every caller is a Celery prefork task using the sync
SQLAlchemy session, like the other Celery workers in this project.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

# Opaque JSON owned by the adapter that created it.
CloudTaskRef = dict[str, Any]


class DriveErrorKind(StrEnum):
    TRANSIENT = "transient"
    PERMANENT = "permanent"


class DriveError(Exception):
    """Classified by the adapter so business code never parses messages."""

    def __init__(self, kind: DriveErrorKind, message: str) -> None:
        super().__init__(message)
        self.kind = kind

    @property
    def transient(self) -> bool:
        return self.kind == DriveErrorKind.TRANSIENT


class CloudTaskState(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    NOT_FOUND = "not_found"


@dataclass(frozen=True)
class CloudTaskStatus:
    state: CloudTaskState
    total_bytes: int | None = None
    error: str | None = None


@dataclass(frozen=True)
class SubmitReceipt:
    ref: CloudTaskRef


@dataclass(frozen=True)
class DirEntry:
    name: str
    size: int
    is_dir: bool
    created: datetime | None
    sign: str
    thumb: str


@dataclass(frozen=True)
class DriveHealth:
    ok: bool
    error: str | None = None


@dataclass(frozen=True)
class PlayLinks:
    file_page: str
    direct: str | None


class CloudDriveAdapter(Protocol):
    def submit_offline(self, *, magnet: str, target_dir: str) -> SubmitReceipt: ...

    def get_task(self, ref: CloudTaskRef) -> CloudTaskStatus: ...

    def find_existing(self, *, infohash: str, target_dir: str) -> CloudTaskRef | None: ...

    def list_dir(self, path: str) -> list[DirEntry]: ...

    def health(self) -> DriveHealth: ...

    def play_links(self, path: str, entry: DirEntry | None) -> PlayLinks: ...


def join_path(*parts: str) -> str:
    """Join drive paths with single slashes; the result is absolute."""
    segments = [segment for part in parts for segment in part.split("/") if segment]
    return "/" + "/".join(segments)
