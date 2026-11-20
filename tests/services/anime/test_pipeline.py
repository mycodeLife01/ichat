"""PostgreSQL integration tests for the anime pipeline state machine."""

import os
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from threading import Barrier
from typing import Any

import pytest
from sqlalchemy import create_engine, delete, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.models.anime import AnimeDownload, AnimeFeed, AnimeIntegrationState, AnimeRelease
from app.services.anime.downloads import (
    NOTIFY_MAX_ATTEMPTS,
    SUBMIT_MAX_ATTEMPTS,
    DownloadActionError,
    add_manual_download,
    check_download,
    due_check_ids,
    maintenance_due,
    notify_download,
    retry_download,
    submit_download,
)
from app.services.anime.drive import (
    CloudTaskRef,
    CloudTaskState,
    CloudTaskStatus,
    DirEntry,
    DriveError,
    DriveErrorKind,
    DriveHealth,
    PlayLinks,
    SubmitReceipt,
    join_path,
)
from app.services.anime.feeds import claim_due_feeds, poll_feed
from app.services.anime.filters import DEFAULT_FILTERS
from app.services.anime.health import feed_key, record_state, send_due_alerts
from app.services.anime.notify import Notification, NotifyError
from app.services.anime.sources import FeedFetchError

TEST_DATABASE_URL = os.environ.get(
    "ANIME_TEST_DATABASE_URL",
    "postgresql+psycopg://ichat:ichat_password@localhost:5432/ichat",
)
# Every row this module creates is recognizable for cleanup.
HASH_PREFIX = "eeee0000"
FEED_PREFIX = "anime-test-"
LEASE = 300
STALL = 3600


def _hash() -> str:
    return HASH_PREFIX + uuid.uuid4().hex


def _clean(session: Session) -> None:
    feed_ids = select(AnimeFeed.id).where(AnimeFeed.name.like(f"{FEED_PREFIX}%"))
    keys = _feed_keys(session)
    if keys:
        session.execute(delete(AnimeIntegrationState).where(AnimeIntegrationState.key.in_(keys)))
    session.execute(delete(AnimeDownload).where(AnimeDownload.infohash.like(f"{HASH_PREFIX}%")))
    session.execute(delete(AnimeRelease).where(AnimeRelease.infohash.like(f"{HASH_PREFIX}%")))
    session.execute(delete(AnimeFeed).where(AnimeFeed.id.in_(feed_ids)))


def _feed_keys(session: Session) -> list[str]:
    ids = session.scalars(select(AnimeFeed.id).where(AnimeFeed.name.like(f"{FEED_PREFIX}%")))
    return [feed_key(feed_id) for feed_id in ids]


@pytest.fixture()
def factory() -> Iterator[sessionmaker[Session]]:
    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    made = sessionmaker(engine, expire_on_commit=False)
    with made() as setup:
        _clean(setup)
        setup.commit()
    yield made
    with made() as teardown:
        _clean(teardown)
        teardown.commit()
    engine.dispose()


# --- fakes ---------------------------------------------------------------------


@dataclass
class FakeDrive:
    existing: CloudTaskRef | None = None
    submit_error: DriveError | None = None
    status: CloudTaskStatus = field(default_factory=lambda: CloudTaskStatus(CloudTaskState.RUNNING))
    entries: dict[str, list[DirEntry]] = field(default_factory=dict)
    submits: int = 0
    on_submit: Callable[[], None] | None = None
    on_get_task: Callable[[], object] | None = None

    def submit_offline(self, *, magnet: str, target_dir: str) -> SubmitReceipt:
        if self.on_submit:
            self.on_submit()
        if self.submit_error:
            raise self.submit_error
        self.submits += 1
        return SubmitReceipt(ref={"id": f"task-{self.submits}"})

    def get_task(self, ref: CloudTaskRef) -> CloudTaskStatus:
        if self.on_get_task:
            self.on_get_task()
        return self.status

    def find_existing(self, *, infohash: str, target_dir: str) -> CloudTaskRef | None:
        return self.existing

    def list_dir(self, path: str) -> list[DirEntry]:
        return list(self.entries.get(path, []))

    def health(self) -> DriveHealth:
        return DriveHealth(ok=True)

    def play_links(self, path: str, entry: DirEntry | None) -> PlayLinks:
        name = entry.name if entry else ""
        page = f"https://list.example.com{join_path(path, name)}"
        if entry is None or not entry.sign:
            return PlayLinks(page, None)
        direct = f"https://list.example.com/d{join_path(path, name)}?sign={entry.sign}"
        return PlayLinks(page, direct)


@dataclass
class FakeNotifier:
    errors: list[NotifyError] = field(default_factory=list)
    sent: list[Notification] = field(default_factory=list)

    def send(self, notification: Notification) -> None:
        if self.errors:
            raise self.errors.pop(0)
        self.sent.append(notification)


def _entry(name: str, size: int, created: datetime, *, is_dir: bool = False) -> DirEntry:
    return DirEntry(name, size, is_dir, created, sign="s1" if not is_dir else "", thumb="")


def _make_download(
    session: Session,
    *,
    status: str = "pending",
    target_dir: str = "/A",
    series: str | None = None,
    episode: int | None = 1,
    **fields: Any,
) -> AnimeDownload:
    infohash = _hash()
    session.add(
        AnimeRelease(
            infohash=infohash,
            title=f"[G] {series or 'Show'} - 01",
            source="mikan",
            torrent_url=f"https://mikanani.me/Download/x/{infohash}.torrent",
            parsed={"series": series or f"Show {infohash[-6:]}", "episode": episode},
        )
    )
    session.flush()
    row = AnimeDownload(
        infohash=infohash, origin="feed", target_dir=target_dir, status=status, **fields
    )
    session.add(row)
    session.flush()
    return row


def _load(factory: sessionmaker[Session], public_id: uuid.UUID) -> AnimeDownload:
    with factory() as session:
        row = session.scalar(select(AnimeDownload).where(AnimeDownload.public_id == public_id))
        assert row is not None
        return row


def _running(factory: sessionmaker[Session], **fields: Any) -> uuid.UUID:
    now = datetime.now(UTC)
    with factory() as session:
        defaults: dict[str, Any] = {
            "cloud_task": {"id": "task-1"},
            "first_claimed_at": now - timedelta(minutes=5),
            "submitted_at": now - timedelta(minutes=5),
            "next_check_at": now - timedelta(seconds=1),
        }
        defaults.update(fields)
        row = _make_download(session, status="running", **defaults)
        session.commit()
        return row.public_id


# --- feeds -----------------------------------------------------------------------


def _rss(items: list[tuple[str, str, datetime | None, bool]]) -> bytes:
    parts = []
    for infohash, title, published, enclosure in items:
        pub = ""
        if published is not None:
            local = published.astimezone(UTC) + timedelta(hours=8)
            pub = f"<pubDate>{local.replace(tzinfo=None).isoformat()}</pubDate>"
        enc = (
            f'<enclosure type="application/x-bittorrent" length="1" '
            f'url="https://mikanani.me/Download/x/{infohash}.torrent" />'
            if enclosure
            else ""
        )
        parts.append(
            f"<item><title>{title}</title>"
            f"<link>https://mikanani.me/Home/Episode/{infohash}</link>"
            f'<torrent xmlns="https://mikanani.me/0.1/"><contentLength>1</contentLength>{pub}'
            f"</torrent>{enc}</item>"
        )
    return f'<rss version="2.0"><channel>{"".join(parts)}</channel></rss>'.encode()


def _make_feed(session: Session, **filters: Any) -> int:
    feed = AnimeFeed(
        name=f"{FEED_PREFIX}{uuid.uuid4().hex[:8]}",
        source="mikan",
        url="https://mikanani.me/RSS/MyBangumi?token=t",
        target_dir="/Feed",
        filters={**DEFAULT_FILTERS, **filters},
        poll_interval_seconds=600,
        next_poll_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    session.add(feed)
    session.flush()
    return feed.id


def test_poll_is_idempotent_and_applies_skip_rules(factory: sessionmaker[Session]) -> None:
    with factory() as session:
        feed_id = _make_feed(session)
        session.commit()
    series = f"番{uuid.uuid4().hex[:6]}"
    now = datetime.now(UTC)
    first, dupe, batch, old, bare = (_hash() for _ in range(5))
    body = _rss(
        [
            (dupe, f"[B] {series} - 03 [1080p]", now - timedelta(minutes=1), True),
            (first, f"[A] {series} - 03 [1080p]", now - timedelta(minutes=10), True),
            (batch, f"[A] {series} [01-12 合集]", now, True),
            (old, f"[A] {series} - 01 [1080p]", now - timedelta(days=3), True),
            (bare, f"[A] {series} - 04 [1080p]", now, False),
        ]
    )

    result = poll_feed(factory, feed_id, fetch=lambda _: body, storage_root="/root")
    assert result.fetched and result.new_releases == 5
    assert len(result.new_downloads) == 2
    again = poll_feed(factory, feed_id, fetch=lambda _: body, storage_root="/root")
    assert again.new_releases == 0 and again.new_downloads == []

    with factory() as session:
        rows = {
            row.infohash: row
            for row in session.scalars(
                select(AnimeDownload).where(AnimeDownload.feed_id == feed_id)
            )
        }
        assert rows[first].status == "pending"
        assert rows[first].target_dir == f"/root/Feed/{series}"
        assert (rows[dupe].status, rows[dupe].skip_reason) == ("skipped", "episode_dedupe")
        assert rows[batch].skip_reason == "batch"
        assert rows[old].skip_reason == "backfill"
        assert rows[bare].status == "pending"
        bare_release = session.scalar(select(AnimeRelease).where(AnimeRelease.infohash == bare))
        assert bare_release is not None and bare_release.magnet == f"magnet:?xt=urn:btih:{bare}"
        feed = session.get(AnimeFeed, feed_id)
        assert feed is not None and feed.next_poll_at > now and feed.lease_expires_at is None


def test_concurrent_polls_create_one_download_per_release(
    factory: sessionmaker[Session],
) -> None:
    with factory() as session:
        feed_id = _make_feed(session, episode_dedupe=False)
        session.commit()
    hashes = [_hash() for _ in range(10)]
    body = _rss([(h, f"[A] S{h[-6:]} - 01", datetime.now(UTC), True) for h in hashes])

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(
                lambda _: poll_feed(factory, feed_id, fetch=lambda _: body, storage_root="/"),
                range(4),
            )
        )
    assert sum(len(r.new_downloads) for r in results) == 10
    with factory() as session:
        count = len(
            session.scalars(select(AnimeDownload.id).where(AnimeDownload.feed_id == feed_id)).all()
        )
    assert count == 10


def test_claim_due_feeds_is_exclusive(factory: sessionmaker[Session]) -> None:
    with factory() as session:
        ids = {_make_feed(session) for _ in range(3)}
        session.commit()
    with factory() as first, factory() as second:
        claimed_first = set(claim_due_feeds(first)) & ids
        claimed_second = set(claim_due_feeds(second)) & ids
        first.commit()
        second.commit()
    assert claimed_first == ids and claimed_second == set()
    with factory() as session:
        assert set(claim_due_feeds(session)) & ids == set()


def test_feed_failures_alert_once_and_recover(factory: sessionmaker[Session]) -> None:
    with factory() as session:
        feed_id = _make_feed(session)
        session.commit()
    key = feed_key(feed_id)

    def failing(_: str) -> bytes:
        raise FeedFetchError("ConnectError")

    for _ in range(5):
        poll_feed(factory, feed_id, fetch=failing, storage_root="/")
    with factory() as session:
        feed = session.get(AnimeFeed, feed_id)
        state = session.scalar(
            select(AnimeIntegrationState).where(AnimeIntegrationState.key == key)
        )
        assert feed is not None and feed.consecutive_failures == 5
        assert state is not None and (state.status, state.alerted_status) == ("failing", "ok")

    notifier = FakeNotifier(errors=[NotifyError("down", retryable=True)])
    send_due_alerts(factory, notifier)
    with factory() as session:
        state = session.scalar(
            select(AnimeIntegrationState).where(AnimeIntegrationState.key == key)
        )
        assert state is not None and state.alert_attempts == 1
        assert state.next_alert_at is not None and state.next_alert_at > datetime.now(UTC)
    later = datetime.now(UTC) + timedelta(minutes=2)
    send_due_alerts(factory, notifier, now=later)
    assert any("连续拉取失败" in item.html for item in notifier.sent)
    sent_before = len(notifier.sent)
    send_due_alerts(factory, notifier, now=later + timedelta(minutes=5))
    assert len(notifier.sent) == sent_before  # no repeat while unchanged

    poll_feed(factory, feed_id, fetch=lambda _: _rss([]), storage_root="/")
    send_due_alerts(factory, notifier)
    assert "已恢复" in notifier.sent[-1].html
    with factory() as session:
        state = session.scalar(
            select(AnimeIntegrationState).where(AnimeIntegrationState.key == key)
        )
        assert state is not None and (state.status, state.alerted_status) == ("ok", "ok")


def test_record_state_ok_without_row_is_noop(factory: sessionmaker[Session]) -> None:
    with factory() as session:
        feed_id = _make_feed(session)
        changed = record_state(
            session, key=feed_key(feed_id), status="ok", error=None, now=datetime.now(UTC)
        )
        assert changed is False
        assert (
            session.scalar(
                select(AnimeIntegrationState).where(AnimeIntegrationState.key == feed_key(feed_id))
            )
            is None
        )
        session.rollback()


# --- submit ------------------------------------------------------------------------


def _pending(factory: sessionmaker[Session], **fields: Any) -> uuid.UUID:
    with factory() as session:
        row = _make_download(session, **fields)
        session.commit()
        return row.public_id


def test_submit_moves_to_running(factory: sessionmaker[Session]) -> None:
    public_id = _pending(factory)
    drive = FakeDrive()
    outcome = submit_download(factory, public_id, drive, lease_seconds=LEASE)
    assert (outcome.result, outcome.reconciled) == ("running", False)
    row = _load(factory, public_id)
    assert row.status == "running" and row.cloud_task == {"id": "task-1"}
    assert row.attempt_count == 1 and row.lease_owner is None
    assert row.first_claimed_at is not None and row.next_check_at is not None
    assert submit_download(factory, public_id, drive, lease_seconds=LEASE).result == (
        "not_claimable"
    )
    assert drive.submits == 1


def test_submit_reuses_existing_cloud_task(factory: sessionmaker[Session]) -> None:
    public_id = _pending(factory)
    drive = FakeDrive(existing={"id": "earlier"})
    outcome = submit_download(factory, public_id, drive, lease_seconds=LEASE)
    assert outcome.reconciled and drive.submits == 0
    assert _load(factory, public_id).cloud_task == {"id": "earlier"}


def test_submit_transient_error_backs_off(factory: sessionmaker[Session]) -> None:
    public_id = _pending(factory)
    drive = FakeDrive(submit_error=DriveError(DriveErrorKind.TRANSIENT, "502"))
    assert submit_download(factory, public_id, drive, lease_seconds=LEASE).result == "retry"
    row = _load(factory, public_id)
    assert row.status == "pending" and row.next_attempt_at > datetime.now(UTC)
    assert row.last_error and "502" in row.last_error
    assert submit_download(factory, public_id, drive, lease_seconds=LEASE).result == (
        "not_claimable"
    )


def test_submit_permanent_error_is_dead_and_owes_notification(
    factory: sessionmaker[Session],
) -> None:
    public_id = _pending(factory)
    drive = FakeDrive(submit_error=DriveError(DriveErrorKind.PERMANENT, "permission denied"))
    assert submit_download(factory, public_id, drive, lease_seconds=LEASE).result == "dead"
    row = _load(factory, public_id)
    assert (row.status, row.notify_status) == ("dead", "pending")


def test_submit_exhausted_attempts_dead_without_drive_call(
    factory: sessionmaker[Session],
) -> None:
    public_id = _pending(factory, attempt_count=SUBMIT_MAX_ATTEMPTS)
    drive = FakeDrive()
    assert submit_download(factory, public_id, drive, lease_seconds=LEASE).result == "dead"
    assert drive.submits == 0


def test_expired_submitting_lease_is_reclaimed_and_old_writer_fenced(
    factory: sessionmaker[Session],
) -> None:
    public_id = _pending(factory)
    takeover: dict[str, Any] = {}

    def steal() -> None:
        # Another worker reclaims the lease while this call is in flight.
        with factory() as session:
            session.execute(
                update(AnimeDownload)
                .where(AnimeDownload.public_id == public_id)
                .values(lease_owner="other", lease_expires_at=datetime.now(UTC) - timedelta(1))
            )
            session.commit()
        takeover["done"] = True

    drive = FakeDrive(on_submit=steal)
    assert submit_download(factory, public_id, drive, lease_seconds=LEASE).result == "stale"
    assert takeover["done"]
    row = _load(factory, public_id)
    assert row.status == "submitting" and row.lease_owner == "other"

    # The expired lease is claimable again; find_existing reconciles.
    drive = FakeDrive(existing={"id": "task-1"})
    outcome = submit_download(factory, public_id, drive, lease_seconds=LEASE)
    assert outcome.result == "running" and outcome.reconciled
    row = _load(factory, public_id)
    assert row.attempt_count == 2 and drive.submits == 0


# --- check -------------------------------------------------------------------------


def test_concurrent_checks_converge_to_one_notification(
    factory: sessionmaker[Session],
) -> None:
    now = datetime.now(UTC)
    public_id = _running(factory, target_dir="/A")
    barrier = Barrier(2)
    drive = FakeDrive(
        status=CloudTaskStatus(CloudTaskState.COMPLETED, total_bytes=100),
        entries={"/A": [_entry("ep01.mkv", 100, now)]},
        on_get_task=lambda: barrier.wait(timeout=10),
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(
            pool.map(
                lambda _: check_download(factory, public_id, drive, stall_timeout_seconds=STALL),
                range(2),
            )
        )
    assert sorted(o.result for o in outcomes) == ["completed", "superseded"]
    row = _load(factory, public_id)
    assert row.file_paths == ["/A/ep01.mkv"] and row.notify_status == "pending"
    assert row.cloud_task == {"id": "task-1", "total_bytes": 100}

    notifier = FakeNotifier()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda _: notify_download(
                    factory, public_id, drive, notifier, fetch_thumb=lambda _: None
                ),
                range(2),
            )
        )
    assert sorted(results) == ["sent", "skipped"]
    assert len(notifier.sent) == 1
    message = notifier.sent[0]
    assert "已下载完成" in message.html and "sign=s1" in message.html
    assert _load(factory, public_id).notify_status == "sent"


def test_check_running_reschedules_with_adaptive_delay(factory: sessionmaker[Session]) -> None:
    public_id = _running(factory)
    outcome = check_download(factory, public_id, FakeDrive(), stall_timeout_seconds=STALL)
    assert (outcome.result, outcome.delay_seconds) == ("rescheduled", 30)
    assert _load(factory, public_id).next_check_at > datetime.now(UTC)


def test_locate_skips_older_claimed_and_size_mismatched_entries(
    factory: sessionmaker[Session],
) -> None:
    now = datetime.now(UTC)
    with factory() as session:
        _make_download(session, status="completed", target_dir="/B", file_paths=["/B/taken.mkv"])
        session.commit()
    public_id = _running(factory, target_dir="/B")
    drive = FakeDrive(
        status=CloudTaskStatus(CloudTaskState.COMPLETED, total_bytes=300),
        entries={
            "/B": [
                _entry("before.mkv", 300, now - timedelta(days=1)),
                _entry("taken.mkv", 300, now),
                _entry("wrong-size.mkv", 299, now),
                _entry("Batch", 0, now, is_dir=True),
            ],
            "/B/Batch": [_entry("01.mkv", 100, now), _entry("02.mkv", 200, now)],
        },
    )
    assert check_download(factory, public_id, drive, stall_timeout_seconds=STALL).result == (
        "completed"
    )
    assert _load(factory, public_id).file_paths == ["/B/Batch/01.mkv", "/B/Batch/02.mkv"]


def test_lost_task_waits_then_fails_as_missing(factory: sessionmaker[Session]) -> None:
    public_id = _running(factory, target_dir="/C")
    drive = FakeDrive(status=CloudTaskStatus(CloudTaskState.NOT_FOUND))
    assert check_download(factory, public_id, drive, stall_timeout_seconds=STALL).result == (
        "rescheduled"
    )
    row = _load(factory, public_id)
    assert row.cloud_task and row.cloud_task.get("lost") is True

    later = datetime.now(UTC) + timedelta(seconds=STALL + 60)
    outcome = check_download(
        factory, public_id, drive, stall_timeout_seconds=STALL, clock=lambda: later
    )
    assert outcome.result == "failed"
    row = _load(factory, public_id)
    assert (row.last_error, row.notify_status) == ("cloud_task_missing", "pending")

    notifier = FakeNotifier()
    assert (
        notify_download(
            factory, public_id, drive, notifier, fetch_thumb=lambda _: None, clock=lambda: later
        )
        == "sent"
    )
    assert "云端任务已不可查" in notifier.sent[0].html


def test_lost_task_completes_when_file_is_unique(factory: sessionmaker[Session]) -> None:
    now = datetime.now(UTC)
    public_id = _running(factory, target_dir="/D", cloud_task={"id": "t", "lost": True})
    drive = FakeDrive(entries={"/D": [_entry("ep.mkv", 5, now)]})
    assert check_download(factory, public_id, drive, stall_timeout_seconds=STALL).result == (
        "completed"
    )
    drive.entries["/D"].append(_entry("other.mkv", 5, now))
    second = _running(factory, target_dir="/D", cloud_task={"id": "t2", "lost": True})
    # Only other.mkv is unclaimed now, so it is unique again.
    assert check_download(factory, second, drive, stall_timeout_seconds=STALL).result == (
        "completed"
    )
    assert _load(factory, second).file_paths == ["/D/other.mkv"]


def test_cloud_failure_marks_failed(factory: sessionmaker[Session]) -> None:
    public_id = _running(factory)
    drive = FakeDrive(status=CloudTaskStatus(CloudTaskState.FAILED, error="bad torrent"))
    assert check_download(factory, public_id, drive, stall_timeout_seconds=STALL).result == (
        "failed"
    )
    assert _load(factory, public_id).last_error == "bad torrent"


def test_drive_errors_reschedule_until_stalled(factory: sessionmaker[Session]) -> None:
    public_id = _running(factory)

    class Broken(FakeDrive):
        def get_task(self, ref: CloudTaskRef) -> CloudTaskStatus:
            raise DriveError(DriveErrorKind.TRANSIENT, "timeout")

    drive = Broken()
    assert check_download(factory, public_id, drive, stall_timeout_seconds=STALL).result == (
        "rescheduled"
    )
    later = datetime.now(UTC) + timedelta(seconds=STALL + 60)
    assert (
        check_download(
            factory, public_id, drive, stall_timeout_seconds=STALL, clock=lambda: later
        ).result
        == "failed"
    )


def test_due_check_ids_finds_overdue_running_rows(factory: sessionmaker[Session]) -> None:
    overdue = _running(factory, next_check_at=datetime.now(UTC) - timedelta(minutes=5))
    fresh = _running(factory, next_check_at=datetime.now(UTC) + timedelta(minutes=5))
    with factory() as session:
        ids = set(due_check_ids(session))
    assert overdue in ids and fresh not in ids


# --- notify ------------------------------------------------------------------------


def _owing(factory: sessionmaker[Session]) -> uuid.UUID:
    with factory() as session:
        row = _make_download(
            session,
            status="failed",
            last_error="x",
            notify_status="pending",
            notify_next_attempt_at=datetime.now(UTC) - timedelta(seconds=1),
        )
        session.commit()
        return row.public_id


def test_notify_retries_then_dies(factory: sessionmaker[Session]) -> None:
    public_id = _owing(factory)
    notifier = FakeNotifier(
        errors=[NotifyError("429", retryable=True) for _ in range(NOTIFY_MAX_ATTEMPTS)]
    )
    moment = datetime.now(UTC)
    results = []
    for step in range(NOTIFY_MAX_ATTEMPTS + 1):
        at = moment + timedelta(days=step)
        results.append(
            notify_download(
                factory,
                public_id,
                FakeDrive(),
                notifier,
                fetch_thumb=lambda _: None,
                clock=lambda at=at: at,
            )
        )
    assert results == ["retry"] * (NOTIFY_MAX_ATTEMPTS - 1) + ["dead", "skipped"]
    assert _load(factory, public_id).notify_status == "dead"


def test_notify_permanent_error_dies_immediately(factory: sessionmaker[Session]) -> None:
    public_id = _owing(factory)
    notifier = FakeNotifier(errors=[NotifyError("400", retryable=False)])
    assert (
        notify_download(factory, public_id, FakeDrive(), notifier, fetch_thumb=lambda _: None)
        == "dead"
    )


def test_maintenance_finds_due_submit_and_notify(factory: sessionmaker[Session]) -> None:
    pending = _pending(factory)
    owing = _owing(factory)
    with factory() as session:
        due = maintenance_due(session)
    assert pending in due.submit and owing in due.notify


# --- operator actions ------------------------------------------------------------------


def test_retry_resets_failed_download(factory: sessionmaker[Session]) -> None:
    public_id = _owing(factory)
    with factory() as session:
        row = retry_download(session, public_id)
        session.commit()
    row = _load(factory, public_id)
    assert (row.status, row.notify_status, row.attempt_count) == ("pending", "none", 0)
    with factory() as session, pytest.raises(DownloadActionError):
        retry_download(session, public_id)


def test_manual_add_is_idempotent(factory: sessionmaker[Session]) -> None:
    infohash = _hash()
    magnet = f"magnet:?xt=urn:btih:{infohash}&dn=%5BA%5D%20Show%20-%2002"
    with factory() as session:
        first, created = add_manual_download(session, magnet=magnet, target_dir="/Manual")
        again, created_again = add_manual_download(session, magnet=magnet, target_dir="/Manual")
        session.commit()
    assert created and not created_again and first == again
    with factory() as session:
        release = session.scalar(select(AnimeRelease).where(AnimeRelease.infohash == infohash))
        assert release is not None and release.title == "[A] Show - 02"
        assert release.parsed["episode"] == 2


def test_check_before_due_is_skipped_so_chains_do_not_fork(
    factory: sessionmaker[Session],
) -> None:
    public_id = _running(factory)
    drive = FakeDrive()
    first = check_download(factory, public_id, drive, stall_timeout_seconds=STALL)
    assert first.result == "rescheduled"
    # A sweep-triggered duplicate arriving right after must not reschedule again.
    second = check_download(factory, public_id, drive, stall_timeout_seconds=STALL)
    assert second.result == "skipped"


def test_completed_notification_parses_file_name_when_title_is_bare(
    factory: sessionmaker[Session],
) -> None:
    infohash = _hash()
    with factory() as session:
        public_id, _ = add_manual_download(
            session, magnet=f"magnet:?xt=urn:btih:{infohash}", target_dir="/Manual"
        )
        session.execute(
            update(AnimeDownload)
            .where(AnimeDownload.public_id == public_id)
            .values(
                status="completed",
                file_paths=[
                    "/Manual/[Nekomoe kissaten][Kusuriya no Hitorigoto][55][1080p][JPTC].mp4"
                ],
                notify_status="pending",
                notify_next_attempt_at=datetime.now(UTC) - timedelta(seconds=1),
            )
        )
        session.commit()
    notifier = FakeNotifier()
    result = notify_download(factory, public_id, FakeDrive(), notifier, fetch_thumb=lambda _: None)
    assert result == "sent"
    html = notifier.sent[0].html
    assert "Kusuriya no Hitorigoto 第 55 集" in html
    assert "Nekomoe kissaten · 1080p" in html
    assert infohash not in html.split("\n")[0]
