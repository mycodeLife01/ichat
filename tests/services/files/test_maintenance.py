"""Lifecycle sweeps keep PostgreSQL facts, quota, and object cleanup aligned."""

from __future__ import annotations

import os
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, event, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, get_settings
from app.db.sync_session import create_sync_engine
from app.models.conversation import Conversation, Message
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FileObjectRole,
    FilePurpose,
    FileQuota,
    FileStorageLocation,
    FileUpload,
    FileUploadStatus,
    MessageAttachment,
)
from app.models.user import User
from app.services.files.avatar import sweep_avatar_uploads
from app.services.files.maintenance import (
    process_deletions,
    purge_deleted_conversations,
    quota_reconciliation_user_ids,
    reclaim_assets,
    reconcile_quota,
    sweep_uploads,
)
from app.services.files.storage import FakeFileStorage

TEST_DATABASE_URL = os.environ.get(
    "FILE_MAINTENANCE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "file-maintenance-test.example.com"


@pytest.fixture()
def session_factory() -> Iterator[sessionmaker[Session]]:
    settings = get_settings().model_copy(update={"database_url": TEST_DATABASE_URL})
    engine = create_sync_engine(settings)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        _clean(session)
        session.commit()
    yield factory
    with factory() as session:
        _clean(session)
        session.commit()
    engine.dispose()


@pytest.fixture()
def file_settings() -> Settings:
    return get_settings().model_copy(
        update={
            "files_maintenance_batch_size": 100,
            "files_processing_max_attempts": 3,
            "files_detached_retention_seconds": 30 * 86_400,
        }
    )


def _clean(session: Session) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_DOMAIN}"))
    file_ids = select(FileAsset.id).where(FileAsset.user_id.in_(user_ids))
    object_ids = select(FileObject.id).where(FileObject.file_id.in_(file_ids))
    session.execute(
        delete(FileObjectDeletion).where(FileObjectDeletion.file_object_id.in_(object_ids))
    )
    session.execute(
        delete(FileObjectDeletion).where(
            FileObjectDeletion.object_key.like("file-maintenance-test/%")
        )
    )
    session.execute(delete(User).where(User.id.in_(user_ids)))


def _user(session: Session) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"maintenance-{suffix}",
        email=f"maintenance-{suffix}@{TEST_DOMAIN}",
        password_hash="hash",
        email_verified=True,
        is_active=True,
    )
    session.add(user)
    session.flush()
    return user


def _asset_with_original(
    session: Session,
    user: User,
    *,
    key: str,
    now: datetime,
    unbound_expires_at: datetime | None = None,
    detached_at: datetime | None = None,
) -> FileAsset:
    asset = FileAsset(
        user_id=user.id,
        purpose=FilePurpose.MESSAGE_ATTACHMENT,
        original_filename="report.txt",
        media_type="text/plain",
        size_bytes=11,
        sha256="f" * 64,
        document_text="report body",
        model_consumable=True,
        unbound_expires_at=unbound_expires_at,
        detached_at=detached_at,
    )
    session.add(asset)
    session.flush()
    session.add(
        FileObject(
            file_id=asset.id,
            role=FileObjectRole.ORIGINAL,
            storage_location=FileStorageLocation.CANONICAL_PRIVATE,
            object_key=key,
            media_type="text/plain",
            size_bytes=11,
            sha256="f" * 64,
        )
    )
    return asset


def test_pending_ttl_releases_reservation_without_extending_on_reads(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    with session_factory() as session:
        user = _user(session)
        session.add(FileQuota(user_id=user.id, reserved_bytes=10))
        upload = FileUpload(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="pending.txt",
            declared_content_type="text/plain",
            declared_size_bytes=10,
            staging_object_key=f"file-staging/{uuid4().hex}.txt",
            status=FileUploadStatus.PENDING,
            available_at=now - timedelta(minutes=31),
            expires_at=now,
        )
        session.add(upload)
        session.commit()

        assert sweep_uploads(session, settings=file_settings, now=now) == []
        session.commit()

        refreshed = session.get(FileUpload, upload.id)
        quota = session.get(FileQuota, user.id)
        assert refreshed is not None and refreshed.status == FileUploadStatus.EXPIRED
        assert refreshed.error_code == "upload_expired"
        assert quota is not None and quota.reserved_bytes == 0


@pytest.mark.parametrize("purpose", [FilePurpose.MESSAGE_ATTACHMENT, FilePurpose.AVATAR])
def test_terminal_manifest_sweep_advances_beyond_the_first_batch(
    session_factory: sessionmaker[Session],
    file_settings: Settings,
    purpose: FilePurpose,
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    settings = file_settings.model_copy(
        update={
            "files_maintenance_batch_size": 1,
            "avatar_maintenance_batch_size": 1,
            "avatar_public_base_url": "https://assets.example.test",
        }
    )
    with session_factory() as session:
        user = _user(session)
        uploads: list[FileUpload] = []
        for index in range(2):
            role = "avatar_512" if purpose == FilePurpose.AVATAR else "original"
            upload = FileUpload(
                user_id=user.id,
                purpose=purpose,
                original_filename="terminal.txt",
                declared_content_type="text/plain",
                declared_size_bytes=10,
                staging_object_key=f"file-staging/{uuid4().hex}.txt",
                status=FileUploadStatus.CANCELLED,
                available_at=now,
                expires_at=now,
                completed_at=now + timedelta(seconds=index),
                output_manifest=[
                    {
                        "role": role,
                        "object_key": f"file-maintenance-test/{purpose.value}/{index}",
                    }
                ],
            )
            uploads.append(upload)
            session.add(upload)
        session.commit()

        if purpose == FilePurpose.AVATAR:
            sweep_avatar_uploads(session, settings=settings, now=now + timedelta(minutes=1))
        else:
            sweep_uploads(session, settings=settings, now=now + timedelta(minutes=1))
        session.commit()
        assert session.get(FileUpload, uploads[0].id).output_manifest is None
        assert session.get(FileUpload, uploads[1].id).output_manifest is not None

        if purpose == FilePurpose.AVATAR:
            sweep_avatar_uploads(session, settings=settings, now=now + timedelta(minutes=1))
        else:
            sweep_uploads(session, settings=settings, now=now + timedelta(minutes=1))
        session.commit()

        assert session.get(FileUpload, uploads[1].id).output_manifest is None
        deletion_count = session.scalar(
            select(func.count(FileObjectDeletion.id)).where(
                FileObjectDeletion.object_key.like(
                    f"file-maintenance-test/{purpose.value}/%"
                )
            )
        )
        assert deletion_count == 2


def test_reclaim_and_private_deletion_release_used_quota_before_r2_cleanup(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeFileStorage()
    with session_factory() as session:
        user = _user(session)
        asset = _asset_with_original(
            session,
            user,
            key=f"files/{uuid4().hex}/original",
            now=now,
            unbound_expires_at=now,
        )
        object_row = session.scalar(select(FileObject).where(FileObject.file_id == asset.id))
        assert object_row is not None
        storage.put_canonical(
            object_row.object_key,
            content=b"report body",
            content_type="text/plain",
        )
        session.add(FileQuota(user_id=user.id, used_bytes=11))
        session.commit()

        assert reclaim_assets(session, settings=file_settings, now=now) == 1
        quota = session.get(FileQuota, user.id)
        deletion = session.scalar(
            select(FileObjectDeletion).where(FileObjectDeletion.object_key == object_row.object_key)
        )
        assert quota is not None and quota.used_bytes == 0
        assert deletion is not None and deletion.completed_at is None
        session.commit()

        completed_count = process_deletions(
            session,
            settings=file_settings,
            private_storage=storage,
            storage_locations={FileStorageLocation.CANONICAL_PRIVATE},
            now=now,
        )
        session.commit()

        assert completed_count >= 1
        assert object_row.object_key in storage.deleted_canonical
        assert session.get(FileAsset, asset.id) is None
        completed = session.get(FileObjectDeletion, deletion.id)
        assert completed is not None and completed.completed_at == now


class _DeleteFailsOnce(FakeFileStorage):
    def __init__(self) -> None:
        super().__init__()
        self.fail_once = True

    def delete_canonical(self, object_key: str) -> None:
        if self.fail_once:
            self.fail_once = False
            raise ConnectionError("temporary object store failure")
        super().delete_canonical(object_key)


def test_private_deletion_compensation_retries_after_partial_external_failure(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = _DeleteFailsOnce()
    with session_factory() as session:
        user = _user(session)
        asset = _asset_with_original(
            session,
            user,
            key=f"files/{uuid4().hex}/original",
            now=now,
        )
        object_row = session.scalar(select(FileObject).where(FileObject.file_id == asset.id))
        assert object_row is not None
        storage.put_canonical(
            object_row.object_key,
            content=b"report body",
            content_type="text/plain",
        )
        asset.deletion_started_at = now
        deletion = FileObjectDeletion(
            file_object_id=object_row.id,
            storage_location=FileStorageLocation.CANONICAL_PRIVATE,
            object_key=object_row.object_key,
            available_at=now,
        )
        session.add(deletion)
        session.commit()

        process_deletions(
            session,
            settings=file_settings,
            private_storage=storage,
            storage_locations={FileStorageLocation.CANONICAL_PRIVATE},
            now=now,
        )
        session.commit()
        retried = session.get(FileObjectDeletion, deletion.id)
        assert retried is not None
        assert retried.attempt_count == 1
        assert retried.completed_at is None
        assert retried.available_at == now + timedelta(seconds=60)
        assert retried.error_summary == "object_delete:ConnectionError"

        completed_count = process_deletions(
            session,
            settings=file_settings,
            private_storage=storage,
            storage_locations={FileStorageLocation.CANONICAL_PRIVATE},
            now=now + timedelta(seconds=60),
        )
        session.commit()

        assert completed_count >= 1
        completed = session.get(FileObjectDeletion, deletion.id)
        assert completed is not None and completed.completed_at == now + timedelta(seconds=60)
        assert session.get(FileAsset, asset.id) is None


def test_conversation_purge_creates_deletion_facts_and_quota_reconciliation_is_idempotent(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    with session_factory() as session:
        user = _user(session)
        conversation = Conversation(
            user_id=user.id,
            title="Deleted",
            deleted_at=now - timedelta(days=30),
            deletion_due_at=now,
        )
        session.add(conversation)
        session.flush()
        message = Message(conversation_id=conversation.id, role="user", content="", position=1)
        session.add(message)
        session.flush()
        asset = _asset_with_original(
            session,
            user,
            key=f"files/{uuid4().hex}/original",
            now=now,
        )
        asset.bound_at = now - timedelta(days=1)
        session.add(
            MessageAttachment(
                message_id=message.id,
                file_id=asset.id,
                position=0,
                name=asset.original_filename,
                media_type=asset.media_type,
                size_bytes=asset.size_bytes,
            )
        )
        # Deliberately wrong values prove reconciliation detects and repairs
        # both directions while deleted conversations still count as used.
        quota = FileQuota(user_id=user.id, used_bytes=999, reserved_bytes=999)
        session.add(quota)
        pending = FileUpload(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="reserved.txt",
            declared_content_type="text/plain",
            declared_size_bytes=7,
            staging_object_key=f"file-staging/{uuid4().hex}.txt",
            status=FileUploadStatus.PENDING,
            available_at=now,
            expires_at=now + timedelta(minutes=30),
        )
        session.add(pending)
        session.commit()

        assert reconcile_quota(session, user_id=user.id) == (11 - 999, 7 - 999)
        assert reconcile_quota(session, user_id=user.id) == (0, 0)
        session.commit()
        assert purge_deleted_conversations(session, settings=file_settings, now=now) == 1
        session.commit()

        assert session.get(Conversation, conversation.id) is None
        retained_asset = session.get(FileAsset, asset.id)
        assert retained_asset is not None and retained_asset.deletion_started_at == now
        quota = session.get(FileQuota, user.id)
        assert quota is not None and quota.used_bytes == 0
        assert session.scalar(
            select(FileObjectDeletion.id).where(FileObjectDeletion.file_object_id.is_not(None))
        ) is not None


def test_quota_reconciliation_rotates_past_the_oldest_batch(
    session_factory: sessionmaker[Session],
) -> None:
    old = datetime(2026, 1, 1, tzinfo=UTC)
    with session_factory() as session:
        users = [_user(session) for _ in range(3)]
        for index, user in enumerate(users):
            session.add(
                FileQuota(
                    user_id=user.id,
                    updated_at=old + timedelta(seconds=index),
                )
            )
        session.commit()

        first_batch = quota_reconciliation_user_ids(session, limit=2)
        assert first_batch == [users[0].id, users[1].id]
        for user_id in first_batch:
            reconcile_quota(session, user_id=user_id)
        session.commit()

        second_batch = quota_reconciliation_user_ids(session, limit=2)
        assert second_batch[0] == users[2].id


def test_quota_reconciliation_does_not_overwrite_a_concurrent_reservation(
    session_factory: sessionmaker[Session],
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    with session_factory() as session:
        user = _user(session)
        session.add(FileQuota(user_id=user.id))
        session.commit()
        user_id = user.id

    engine = session_factory.kw["bind"]
    assert engine is not None
    paused_before_quota_lock = threading.Event()
    resume_reconciliation = threading.Event()
    errors: list[BaseException] = []
    worker_thread: threading.Thread

    def pause_before_quota_lock(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if (
            threading.current_thread() is worker_thread
            and "FROM file_quotas" in statement
            and "FOR UPDATE" in statement
        ):
            paused_before_quota_lock.set()
            if not resume_reconciliation.wait(timeout=5):
                raise TimeoutError("quota reconciliation test did not resume")

    def run_reconciliation() -> None:
        try:
            with session_factory() as session:
                reconcile_quota(session, user_id=user_id)
                session.commit()
        except BaseException as error:  # pragma: no cover - asserted in the parent thread.
            errors.append(error)

    worker_thread = threading.Thread(target=run_reconciliation)
    event.listen(engine, "before_cursor_execute", pause_before_quota_lock)
    try:
        worker_thread.start()
        assert paused_before_quota_lock.wait(timeout=5)
        with session_factory() as writer_session:
            quota = writer_session.scalar(
                select(FileQuota)
                .where(FileQuota.user_id == user_id)
                .with_for_update()
            )
            assert quota is not None
            quota.reserved_bytes += 7
            writer_session.add(
                FileUpload(
                    user_id=user_id,
                    purpose=FilePurpose.MESSAGE_ATTACHMENT,
                    original_filename="concurrent.txt",
                    declared_content_type="text/plain",
                    declared_size_bytes=7,
                    staging_object_key=f"file-staging/{uuid4().hex}.txt",
                    status=FileUploadStatus.PENDING,
                    available_at=now,
                    expires_at=now + timedelta(minutes=30),
                )
            )
            writer_session.commit()
    finally:
        resume_reconciliation.set()
        worker_thread.join(timeout=5)
        event.remove(engine, "before_cursor_execute", pause_before_quota_lock)

    assert not worker_thread.is_alive()
    assert errors == []
    with session_factory() as session:
        quota = session.get(FileQuota, user_id)
        assert quota is not None
        assert quota.reserved_bytes == 7
