"""Download state machine (spec §6.4, §6.5, §7.4, §7.6).

Every network call happens between short transactions. Writes after a call
are conditional: submit write-backs are fenced by ``lease_owner``, check
write-backs by the observed ``next_check_at``, notification write-backs by
the claimed ``notify_attempts``.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qs, urlsplit

from loguru import logger
from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, sessionmaker

from app.models.anime import AnimeDownload, AnimeRelease
from app.services.anime.drive import (
    CloudDriveAdapter,
    CloudTaskRef,
    CloudTaskState,
    CloudTaskStatus,
    DirEntry,
    DriveError,
    PlayLinks,
    join_path,
)
from app.services.anime.infohash import infohash_from_magnet, magnet_for
from app.services.anime.notify import (
    Notification,
    Notifier,
    NotifyError,
    ReleaseInfo,
    compose_completed,
    compose_failed,
)
from app.services.anime.parsing import parse_title

SUBMIT_MAX_ATTEMPTS = 5
NOTIFY_MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (60, 300, 900, 3600, 21600)
FIRST_CHECK_DELAY_SECONDS = 10
CHECK_OVERDUE_GRACE_SECONDS = 30
# Countdown messages may fire slightly early; anything earlier is a stale
# message from a superseded chain and must not start a second chain.
CHECK_EARLY_TOLERANCE_SECONDS = 2
NOTIFY_LEASE_SECONDS = 120
CREATED_TOLERANCE_SECONDS = 60
MAX_FOLDER_DEPTH = 3
VIDEO_EXTENSIONS = (".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".webm", ".flv", ".rmvb")
RETRYABLE_STATUSES = ("failed", "dead", "skipped")
_MAX_ERROR_LEN = 1000


def check_delay_seconds(elapsed_seconds: float) -> int:
    """Adaptive check interval by time since submission (spec §7.4 table)."""
    if elapsed_seconds < 120:
        return 10
    if elapsed_seconds < 600:
        return 30
    if elapsed_seconds < 3600:
        return 120
    return 600


def _backoff(attempt: int) -> timedelta:
    return timedelta(seconds=BACKOFF_SECONDS[min(max(attempt, 1), len(BACKOFF_SECONDS)) - 1])


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _transition(row_id: int, public_id: uuid.UUID, src: str, dst: str, **fields: Any) -> None:
    logger.bind(
        event="anime_download_transition",
        download_id=row_id,
        public_id=str(public_id),
        from_status=src,
        to_status=dst,
        **fields,
    ).info("anime download transition")


# --- submit ------------------------------------------------------------------


@dataclass(frozen=True)
class SubmitOutcome:
    result: str  # missing | not_claimable | running | retry | dead | stale
    ref: CloudTaskRef | None = None
    reconciled: bool = False


def submit_download(
    factory: sessionmaker[Session],
    public_id: uuid.UUID,
    adapter: CloudDriveAdapter,
    *,
    lease_seconds: int,
    clock: Callable[[], datetime] = _utcnow,
) -> SubmitOutcome:
    owner = uuid.uuid4().hex
    with factory() as session:
        row = session.scalar(
            select(AnimeDownload).where(AnimeDownload.public_id == public_id).with_for_update()
        )
        if row is None:
            return SubmitOutcome("missing")
        now = clock()
        due_pending = row.status == "pending" and row.next_attempt_at <= now
        # An expired submitting lease means a worker died or stalled mid-call.
        expired = (
            row.status == "submitting"
            and row.lease_expires_at is not None
            and row.lease_expires_at < now
        )
        if not (due_pending or expired):
            return SubmitOutcome("not_claimable")
        previous = row.status
        if row.attempt_count >= SUBMIT_MAX_ATTEMPTS:
            _mark_terminal(row, "dead", "submit attempts exhausted", now)
            session.commit()
            _transition(row.id, row.public_id, previous, "dead", attempts=row.attempt_count)
            return SubmitOutcome("dead")
        row.status = "submitting"
        row.lease_owner = owner
        row.lease_expires_at = now + timedelta(seconds=lease_seconds)
        row.attempt_count += 1
        if row.first_claimed_at is None:
            row.first_claimed_at = now
        attempt = row.attempt_count
        infohash, target_dir, row_id = row.infohash, row.target_dir, row.id
        magnet = session.scalar(
            select(AnimeRelease.magnet).where(AnimeRelease.infohash == infohash)
        ) or magnet_for(infohash)
        session.commit()
    _transition(row_id, public_id, previous, "submitting", attempt=attempt)

    reconciled = False
    try:
        # Ask the drive first on every attempt: a timed-out or crashed earlier
        # attempt may already have created the task (spec §6.5 step 4).
        ref = adapter.find_existing(infohash=infohash, target_dir=target_dir)
        reconciled = ref is not None
        if ref is None:
            ref = adapter.submit_offline(magnet=magnet, target_dir=target_dir).ref
    except DriveError as exc:
        return _submit_failed(factory, public_id, owner, exc, attempt, clock())

    with factory() as session:
        row = _owned(session, public_id, owner)
        if row is None:
            logger.bind(
                event="anime_download_stale_writeback", public_id=str(public_id), ref=ref
            ).error("submit write-back lost ownership; check for an extra cloud task")
            return SubmitOutcome("stale", ref=ref)
        now = clock()
        row.status = "running"
        row.cloud_task = dict(ref)
        row.submitted_at = now
        row.next_check_at = now + timedelta(seconds=FIRST_CHECK_DELAY_SECONDS)
        row.lease_owner = None
        row.lease_expires_at = None
        row.last_error = None
        session.commit()
    _transition(row_id, public_id, "submitting", "running", reconciled=reconciled)
    return SubmitOutcome("running", ref=ref, reconciled=reconciled)


def _owned(session: Session, public_id: uuid.UUID, owner: str) -> AnimeDownload | None:
    return session.scalar(
        select(AnimeDownload)
        .where(
            AnimeDownload.public_id == public_id,
            AnimeDownload.status == "submitting",
            AnimeDownload.lease_owner == owner,
        )
        .with_for_update()
    )


def _submit_failed(
    factory: sessionmaker[Session],
    public_id: uuid.UUID,
    owner: str,
    exc: DriveError,
    attempt: int,
    now: datetime,
) -> SubmitOutcome:
    error = f"{exc.kind}: {exc}"
    with factory() as session:
        row = _owned(session, public_id, owner)
        if row is None:
            return SubmitOutcome("stale")
        if exc.transient and attempt < SUBMIT_MAX_ATTEMPTS:
            row.status = "pending"
            row.next_attempt_at = now + _backoff(attempt)
            row.lease_owner = None
            row.lease_expires_at = None
            row.last_error = error[:_MAX_ERROR_LEN]
            result = "retry"
        else:
            _mark_terminal(row, "dead", error, now)
            result = "dead"
        row_id = row.id
        session.commit()
    _transition(
        row_id,
        public_id,
        "submitting",
        "pending" if result == "retry" else "dead",
        error_kind=str(exc.kind),
        attempt=attempt,
    )
    return SubmitOutcome(result)


def _mark_terminal(row: AnimeDownload, status: str, error: str | None, now: datetime) -> None:
    """Enter a terminal state and owe a notification in the same transaction."""
    row.status = status
    row.last_error = error[:_MAX_ERROR_LEN] if error else None
    row.lease_owner = None
    row.lease_expires_at = None
    row.next_check_at = None
    if status == "completed":
        row.completed_at = now
    row.notify_status = "pending"
    row.notify_attempts = 0
    row.notify_next_attempt_at = now
    row.notify_lease_expires_at = None


# --- check -------------------------------------------------------------------


@dataclass(frozen=True)
class CheckOutcome:
    result: str  # skipped | rescheduled | completed | failed | superseded
    delay_seconds: int | None = None


@dataclass(frozen=True)
class LocatedFile:
    path: str
    size: int


def locate_files(
    adapter: CloudDriveAdapter,
    *,
    target_dir: str,
    not_before: datetime,
    total_bytes: int | None,
    claimed: set[str],
    unique: bool,
) -> list[LocatedFile] | None:
    """Find the entry a finished task produced (spec §7.4 「定位文件」)."""
    candidates: list[tuple[datetime, list[LocatedFile]]] = []
    for entry in adapter.list_dir(target_dir):
        if entry.created is None or entry.created < not_before:
            continue
        path = join_path(target_dir, entry.name)
        if entry.is_dir:
            # Folder entries report size 0; compare the sum of their files.
            files = _folder_files(adapter, path, depth=1)
        else:
            files = [LocatedFile(path, entry.size)]
        if not files or any(item.path in claimed for item in files):
            continue
        if total_bytes is not None and sum(item.size for item in files) != total_bytes:
            continue
        candidates.append((entry.created, files))
    if not candidates:
        return None
    if unique and len(candidates) != 1:
        return None
    candidates.sort(key=lambda candidate: candidate[0])
    if len(candidates) > 1:
        logger.bind(event="anime_locate_ambiguous", target_dir=target_dir).warning(
            f"{len(candidates)} entries match; using the earliest"
        )
    return candidates[0][1]


def _folder_files(adapter: CloudDriveAdapter, path: str, *, depth: int) -> list[LocatedFile]:
    files: list[LocatedFile] = []
    for child in sorted(adapter.list_dir(path), key=lambda item: item.name):
        child_path = join_path(path, child.name)
        if child.is_dir:
            if depth < MAX_FOLDER_DEPTH:
                files.extend(_folder_files(adapter, child_path, depth=depth + 1))
        else:
            files.append(LocatedFile(child_path, child.size))
    return files


def check_download(
    factory: sessionmaker[Session],
    public_id: uuid.UUID,
    adapter: CloudDriveAdapter,
    *,
    stall_timeout_seconds: int,
    clock: Callable[[], datetime] = _utcnow,
) -> CheckOutcome:
    with factory() as session:
        row = session.scalar(select(AnimeDownload).where(AnimeDownload.public_id == public_id))
        if row is None or row.status != "running" or row.next_check_at is None:
            return CheckOutcome("skipped")
        if row.next_check_at > clock() + timedelta(seconds=CHECK_EARLY_TOLERANCE_SECONDS):
            return CheckOutcome("skipped")
        observed = row.next_check_at
        ref: dict[str, Any] = dict(row.cloud_task or {})
        row_id, target_dir = row.id, row.target_dir
        submitted_at = row.submitted_at or observed
        not_before = (row.first_claimed_at or submitted_at) - timedelta(
            seconds=CREATED_TOLERANCE_SECONDS
        )
        claimed = _claimed_paths(session, row_id, target_dir)

    error: str | None = None
    status: CloudTaskStatus | None
    try:
        if ref.get("lost"):
            status = CloudTaskStatus(CloudTaskState.NOT_FOUND)
        else:
            status = adapter.get_task(ref)
    except DriveError as exc:
        status, error = None, f"{exc.kind}: {exc}"

    if status is not None and status.total_bytes and not ref.get("total_bytes"):
        ref["total_bytes"] = status.total_bytes
    total_bytes = ref.get("total_bytes")
    now = clock()
    stalled = (now - submitted_at).total_seconds() > stall_timeout_seconds
    files: list[LocatedFile] | None = None

    if status is not None and status.state == CloudTaskState.COMPLETED:
        try:
            files = locate_files(
                adapter,
                target_dir=target_dir,
                not_before=not_before,
                total_bytes=total_bytes,
                claimed=claimed,
                unique=False,
            )
        except DriveError as exc:
            error = f"{exc.kind}: {exc}"
            return _reschedule(factory, row_id, observed, ref, submitted_at, now, error)
        return _complete(factory, row_id, public_id, observed, ref, files or [], now)

    if status is not None and status.state == CloudTaskState.FAILED:
        return _fail(
            factory, row_id, public_id, observed, ref, status.error or "cloud task failed", now
        )

    if status is not None and status.state == CloudTaskState.NOT_FOUND:
        # OpenList restarted: the PikPak download continues, so look for the
        # file and keep waiting until the stall limit (spec §7.4).
        try:
            files = locate_files(
                adapter,
                target_dir=target_dir,
                not_before=not_before,
                total_bytes=total_bytes,
                claimed=claimed,
                unique=True,
            )
        except DriveError as exc:
            error = f"{exc.kind}: {exc}"
        if files:
            return _complete(factory, row_id, public_id, observed, ref, files, now)
        ref["lost"] = True
        if stalled:
            return _fail(factory, row_id, public_id, observed, ref, "cloud_task_missing", now)
        return _reschedule(factory, row_id, observed, ref, submitted_at, now, error)

    if stalled:
        return _fail(factory, row_id, public_id, observed, ref, error or "stalled", now)
    return _reschedule(factory, row_id, observed, ref, submitted_at, now, error)


def _claimed_paths(session: Session, row_id: int, target_dir: str) -> set[str]:
    rows = session.scalars(
        select(AnimeDownload.file_paths).where(
            AnimeDownload.target_dir == target_dir,
            AnimeDownload.id != row_id,
            AnimeDownload.file_paths.is_not(None),
        )
    ).all()
    return {path for paths in rows if paths for path in paths}


def _conditional(row_id: int, observed: datetime) -> Any:
    return update(AnimeDownload).where(
        AnimeDownload.id == row_id,
        AnimeDownload.status == "running",
        AnimeDownload.next_check_at == observed,
    )


def _reschedule(
    factory: sessionmaker[Session],
    row_id: int,
    observed: datetime,
    ref: dict[str, Any],
    submitted_at: datetime,
    now: datetime,
    error: str | None,
) -> CheckOutcome:
    delay = check_delay_seconds((now - submitted_at).total_seconds())
    values: dict[str, Any] = {
        "next_check_at": now + timedelta(seconds=delay),
        "cloud_task": ref,
        "updated_at": now,
    }
    if error is not None:
        values["last_error"] = error[:_MAX_ERROR_LEN]
    with factory() as session:
        updated = session.scalar(
            _conditional(row_id, observed).values(**values).returning(AnimeDownload.id)
        )
        session.commit()
    if updated is None:
        return CheckOutcome("superseded")
    return CheckOutcome("rescheduled", delay_seconds=delay)


def _complete(
    factory: sessionmaker[Session],
    row_id: int,
    public_id: uuid.UUID,
    observed: datetime,
    ref: dict[str, Any],
    files: list[LocatedFile],
    now: datetime,
) -> CheckOutcome:
    with factory() as session:
        updated = session.scalar(
            _conditional(row_id, observed)
            .values(
                status="completed",
                completed_at=now,
                cloud_task=ref,
                file_paths=[item.path for item in files],
                next_check_at=None,
                last_error=None,
                notify_status="pending",
                notify_attempts=0,
                notify_next_attempt_at=now,
                notify_lease_expires_at=None,
                updated_at=now,
            )
            .returning(AnimeDownload.id)
        )
        session.commit()
    if updated is None:
        return CheckOutcome("superseded")
    _transition(row_id, public_id, "running", "completed", files=len(files))
    return CheckOutcome("completed")


def _fail(
    factory: sessionmaker[Session],
    row_id: int,
    public_id: uuid.UUID,
    observed: datetime,
    ref: dict[str, Any],
    error: str,
    now: datetime,
) -> CheckOutcome:
    with factory() as session:
        updated = session.scalar(
            _conditional(row_id, observed)
            .values(
                status="failed",
                cloud_task=ref,
                next_check_at=None,
                last_error=error[:_MAX_ERROR_LEN],
                notify_status="pending",
                notify_attempts=0,
                notify_next_attempt_at=now,
                notify_lease_expires_at=None,
                updated_at=now,
            )
            .returning(AnimeDownload.id)
        )
        session.commit()
    if updated is None:
        return CheckOutcome("superseded")
    _transition(row_id, public_id, "running", "failed", error=error[:200])
    return CheckOutcome("failed")


# --- notify ------------------------------------------------------------------


@dataclass(frozen=True)
class _ClaimedNotify:
    id: int
    attempts: int
    status: str
    infohash: str
    file_paths: list[str]
    last_error: str | None
    total_bytes: int | None


def notify_download(
    factory: sessionmaker[Session],
    public_id: uuid.UUID,
    adapter: CloudDriveAdapter,
    notifier: Notifier,
    *,
    fetch_thumb: Callable[[str], bytes | None],
    clock: Callable[[], datetime] = _utcnow,
) -> str:
    now = clock()
    with factory() as session:
        row = session.execute(
            update(AnimeDownload)
            .where(
                AnimeDownload.public_id == public_id,
                AnimeDownload.notify_status == "pending",
                or_(
                    AnimeDownload.notify_next_attempt_at.is_(None),
                    AnimeDownload.notify_next_attempt_at <= now,
                ),
                or_(
                    AnimeDownload.notify_lease_expires_at.is_(None),
                    AnimeDownload.notify_lease_expires_at < now,
                ),
            )
            .values(
                notify_attempts=AnimeDownload.notify_attempts + 1,
                notify_lease_expires_at=now + timedelta(seconds=NOTIFY_LEASE_SECONDS),
            )
            .returning(
                AnimeDownload.id,
                AnimeDownload.notify_attempts,
                AnimeDownload.status,
                AnimeDownload.infohash,
                AnimeDownload.file_paths,
                AnimeDownload.last_error,
                AnimeDownload.cloud_task,
            )
        ).one_or_none()
        if row is None:
            session.commit()
            return "skipped"
        claimed = _ClaimedNotify(
            id=row.id,
            attempts=row.notify_attempts,
            status=row.status,
            infohash=row.infohash,
            file_paths=list(row.file_paths or []),
            last_error=row.last_error,
            total_bytes=(row.cloud_task or {}).get("total_bytes"),
        )
        release = session.scalar(
            select(AnimeRelease).where(AnimeRelease.infohash == claimed.infohash)
        )
        info = _release_info(release)
        siblings = (
            _skipped_siblings(session, release, claimed.id) if claimed.status != "completed" else []
        )
        session.commit()

    if claimed.status == "completed":
        notification = _completed_notification(
            adapter, claimed, info, str(public_id), fetch_thumb=fetch_thumb
        )
    else:
        notification = compose_failed(
            info,
            status=claimed.status,
            error=claimed.last_error,
            public_id=str(public_id),
            skipped_siblings=siblings,
        )

    try:
        notifier.send(notification)
        sent, retryable, error = True, False, None
    except NotifyError as exc:
        sent, retryable, error = False, exc.retryable, str(exc)

    done = clock()
    if sent:
        values: dict[str, Any] = {
            "notify_status": "sent",
            "notified_at": done,
            "notify_lease_expires_at": None,
        }
        result = "sent"
    elif retryable and claimed.attempts < NOTIFY_MAX_ATTEMPTS:
        values = {
            "notify_next_attempt_at": done + _backoff(claimed.attempts),
            "notify_lease_expires_at": None,
        }
        result = "retry"
    else:
        values = {"notify_status": "dead", "notify_lease_expires_at": None}
        result = "dead"
    with factory() as session:
        session.execute(
            update(AnimeDownload)
            .where(
                AnimeDownload.id == claimed.id,
                AnimeDownload.notify_status == "pending",
                AnimeDownload.notify_attempts == claimed.attempts,
            )
            .values(**values)
        )
        session.commit()
    logger.bind(
        event="anime_notify_sent" if sent else "anime_notify_failed",
        public_id=str(public_id),
        attempt=claimed.attempts,
        result=result,
    ).info(error or "anime notification sent")
    return result


def _release_info(release: AnimeRelease | None) -> ReleaseInfo:
    parsed = release.parsed if release else {}
    return ReleaseInfo(
        title=release.title if release else "",
        series=parsed.get("series"),
        episode=parsed.get("episode"),
        group=parsed.get("group"),
        resolution=parsed.get("resolution"),
    )


def _skipped_siblings(session: Session, release: AnimeRelease | None, row_id: int) -> list[str]:
    if release is None:
        return []
    series, episode = release.parsed.get("series"), release.parsed.get("episode")
    if not series or episode is None:
        return []
    ids = session.scalars(
        select(AnimeDownload.public_id)
        .join(AnimeRelease, AnimeRelease.infohash == AnimeDownload.infohash)
        .where(
            AnimeDownload.id != row_id,
            AnimeDownload.status == "skipped",
            AnimeRelease.parsed["series"].astext == series,
            AnimeRelease.parsed["episode"].astext == str(episode),
        )
        .limit(5)
    ).all()
    return [str(item) for item in ids]


def pick_video(paths: list[str]) -> str | None:
    if not paths:
        return None
    videos = [path for path in paths if path.lower().endswith(VIDEO_EXTENSIONS)]
    return sorted(videos or paths)[0]


def _info_from_file(path: str, fallback: ReleaseInfo) -> ReleaseInfo:
    """Parse the landed file name when the release title says nothing.

    Manual magnets without ``dn`` are titled by their infohash; the file name
    chosen by the torrent usually carries the series and episode.
    """
    stem = PurePosixPath(path).stem
    parsed = parse_title(stem)
    if not parsed["series"]:
        return fallback
    return ReleaseInfo(
        title=stem,
        series=parsed["series"],
        episode=parsed["episode"] if parsed["episode"] is not None else fallback.episode,
        group=parsed["group"] or fallback.group,
        resolution=parsed["resolution"] or fallback.resolution,
    )


def _completed_notification(
    adapter: CloudDriveAdapter,
    claimed: _ClaimedNotify,
    info: ReleaseInfo,
    public_id: str,
    *,
    fetch_thumb: Callable[[str], bytes | None],
) -> Notification:
    target = pick_video(claimed.file_paths)
    if target is not None and info.series is None:
        info = _info_from_file(target, info)
    links: PlayLinks | None = None
    entry: DirEntry | None = None
    photo: bytes | None = None
    if target is not None:
        directory, _, name = target.rpartition("/")
        directory = directory or "/"
        try:
            # Fetch sign and thumb at send time: the screenshot may only appear
            # after completion, and the sign is only valid from fs/list.
            entry = next((e for e in adapter.list_dir(directory) if e.name == name), None)
        except DriveError as exc:
            logger.bind(event="anime_notify_list_failed", public_id=public_id).warning(str(exc))
        try:
            links = (
                adapter.play_links(directory, entry) if entry else adapter.play_links(target, None)
            )
        except DriveError:
            links = None
        if entry is not None and entry.thumb:
            photo = fetch_thumb(entry.thumb)
    size = claimed.total_bytes or (entry.size if entry else None)
    return compose_completed(
        info,
        size_bytes=size,
        links=links,
        located=target is not None,
        file_count=len(claimed.file_paths),
        photo=photo,
        public_id=public_id,
    )


# --- sweeps --------------------------------------------------------------------


def due_check_ids(session: Session, *, now: datetime | None = None) -> list[uuid.UUID]:
    """Running rows whose countdown message was lost or is stuck."""
    moment = now or _utcnow()
    return list(
        session.scalars(
            select(AnimeDownload.public_id).where(
                AnimeDownload.status == "running",
                AnimeDownload.next_check_at
                < moment - timedelta(seconds=CHECK_OVERDUE_GRACE_SECONDS),
            )
        ).all()
    )


@dataclass(frozen=True)
class MaintenanceDue:
    submit: list[uuid.UUID]
    notify: list[uuid.UUID]


def maintenance_due(session: Session, *, now: datetime | None = None) -> MaintenanceDue:
    moment = now or _utcnow()
    submit = session.scalars(
        select(AnimeDownload.public_id).where(
            or_(
                (AnimeDownload.status == "pending") & (AnimeDownload.next_attempt_at <= moment),
                (AnimeDownload.status == "submitting") & (AnimeDownload.lease_expires_at < moment),
            )
        )
    ).all()
    notify = session.scalars(
        select(AnimeDownload.public_id).where(
            AnimeDownload.notify_status == "pending",
            or_(
                AnimeDownload.notify_next_attempt_at.is_(None),
                AnimeDownload.notify_next_attempt_at <= moment,
            ),
            or_(
                AnimeDownload.notify_lease_expires_at.is_(None),
                AnimeDownload.notify_lease_expires_at < moment,
            ),
        )
    ).all()
    return MaintenanceDue(submit=list(submit), notify=list(notify))


# --- operator actions -----------------------------------------------------------


class DownloadActionError(ValueError):
    pass


def retry_download(session: Session, public_id: uuid.UUID) -> AnimeDownload:
    row = session.scalar(
        select(AnimeDownload).where(AnimeDownload.public_id == public_id).with_for_update()
    )
    if row is None:
        raise DownloadActionError("download not found")
    if row.status not in RETRYABLE_STATUSES:
        raise DownloadActionError(f"cannot retry a {row.status} download")
    row.status = "pending"
    row.skip_reason = None
    row.attempt_count = 0
    row.next_attempt_at = _utcnow()
    row.lease_owner = None
    row.lease_expires_at = None
    row.cloud_task = None
    row.file_paths = None
    row.next_check_at = None
    row.first_claimed_at = None
    row.submitted_at = None
    row.completed_at = None
    row.last_error = None
    row.notify_status = "none"
    row.notify_attempts = 0
    row.notify_next_attempt_at = None
    row.notify_lease_expires_at = None
    row.notified_at = None
    return row


def add_manual_download(
    session: Session, *, magnet: str, target_dir: str
) -> tuple[uuid.UUID, bool]:
    """Create a release and a pending manual download; returns (id, created)."""
    infohash = infohash_from_magnet(magnet)
    display_name = _magnet_display_name(magnet)
    title = display_name or infohash
    session.execute(
        insert(AnimeRelease)
        .values(
            infohash=infohash,
            title=title,
            source="manual",
            magnet=magnet.strip(),
            # A bare infohash is not a title; leave fields empty so the
            # notification falls back to the landed file name.
            parsed=parse_title(display_name or ""),
        )
        .on_conflict_do_nothing(index_elements=["infohash"])
    )
    created = session.scalar(
        insert(AnimeDownload)
        .values(infohash=infohash, origin="manual", target_dir=target_dir, status="pending")
        .on_conflict_do_nothing(index_elements=["infohash"])
        .returning(AnimeDownload.public_id)
    )
    if created is not None:
        return created, True
    existing = session.scalar(
        select(AnimeDownload.public_id).where(AnimeDownload.infohash == infohash)
    )
    assert existing is not None
    return existing, False


def _magnet_display_name(magnet: str) -> str | None:
    names = parse_qs(urlsplit(magnet.strip()).query).get("dn")
    return names[0].strip() if names and names[0].strip() else None
