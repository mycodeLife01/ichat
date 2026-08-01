"""Database-backed processing tests at the files module's worker seam."""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, get_settings
from app.db.sync_session import create_sync_engine
from app.models.files import (
    FileAsset,
    FileObject,
    FileObjectDeletion,
    FileObjectRole,
    FilePurpose,
    FileQuota,
    FileUpload,
    FileUploadStatus,
)
from app.models.user import User
from app.services.files.parsers import DirectFileParser
from app.services.files.processing import process_upload
from app.services.files.protocols import ScanVerdict
from app.services.files.scanner import FakeMalwareScanner
from app.services.files.storage import FakeFileStorage

TEST_DATABASE_URL = os.environ.get(
    "FILE_PROCESSING_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_DOMAIN = "file-processing-test.example.com"


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
            "files_processing_max_attempts": 3,
            "files_processing_lease_seconds": 300,
            "files_unbound_ttl_seconds": 86_400,
        }
    )


def _clean(session: Session) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_DOMAIN}"))
    # FileObjectDeletion deliberately survives removal of its object row.  These
    # test rows are linked to assets belonging to the isolated test users, so
    # remove them before their FK is nulled by the user cascade.
    file_ids = select(FileAsset.id).where(FileAsset.user_id.in_(user_ids))
    object_ids = select(FileObject.id).where(FileObject.file_id.in_(file_ids))
    session.execute(
        delete(FileObjectDeletion).where(FileObjectDeletion.file_object_id.in_(object_ids))
    )
    session.execute(delete(User).where(User.id.in_(user_ids)))


def _seed_queued_upload(
    factory: sessionmaker[Session],
    storage: FakeFileStorage,
    *,
    content: bytes = b"document body",
    now: datetime,
) -> tuple[int, str]:
    with factory() as session:
        suffix = uuid4().hex
        user = User(
            username=f"processor-{suffix}",
            email=f"processor-{suffix}@{TEST_DOMAIN}",
            password_hash="hash",
            email_verified=True,
            is_active=True,
        )
        session.add(user)
        session.flush()
        key = f"file-staging/{suffix}.txt"
        etag = storage.put_staging(
            key,
            content,
            content_type="text/plain",
            declared_size_bytes=len(content),
        )
        upload = FileUpload(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="notes.txt",
            declared_content_type="text/plain",
            declared_size_bytes=len(content),
            staging_object_key=key,
            confirmed_etag=etag,
            status=FileUploadStatus.QUEUED,
            available_at=now,
            expires_at=now + timedelta(minutes=30),
        )
        session.add(upload)
        session.add(FileQuota(user_id=user.id, reserved_bytes=len(content)))
        session.commit()
        return user.id, str(upload.public_id)


def _upload(factory: sessionmaker[Session], upload_id: str) -> FileUpload:
    with factory() as session:
        row = session.scalar(select(FileUpload).where(FileUpload.public_id == upload_id))
        assert row is not None
        session.expunge(row)
        return row


def test_processing_success_commits_asset_manifest_and_quota_atomically(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeFileStorage()
    user_id, upload_id = _seed_queued_upload(session_factory, storage, now=now)

    result = process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(),
        parser=DirectFileParser(),
        task_id="worker-1",
        now=now,
    )

    assert result == "succeeded"
    assert _upload(session_factory, upload_id).status == FileUploadStatus.SUCCEEDED
    assert len(storage.deleted_staging) == 1
    with session_factory() as session:
        upload = session.scalar(select(FileUpload).where(FileUpload.public_id == upload_id))
        assert upload is not None and upload.file_id is not None
        asset = session.get(FileAsset, upload.file_id)
        assert asset is not None
        assert asset.document_text == "document body"
        assert asset.model_consumable is True
        assert asset.unbound_expires_at == now + timedelta(seconds=86_400)
        object_rows = session.scalars(
            select(FileObject).where(FileObject.file_id == asset.id)
        )
        assert {row.role for row in object_rows} == {
            FileObjectRole.ORIGINAL,
            FileObjectRole.DOCUMENT_EXTRACT,
        }
        quota = session.get(FileQuota, user_id)
        assert quota is not None
        assert (quota.used_bytes, quota.reserved_bytes) == (len(b"document body"), 0)
        assert upload.output_manifest is not None
        assert {entry["role"] for entry in upload.output_manifest} == {
            "original",
            "document_extract",
        }


def test_if_match_overwrite_race_retries_without_creating_an_asset(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeFileStorage()
    user_id, upload_id = _seed_queued_upload(session_factory, storage, now=now)
    before = _upload(session_factory, upload_id)
    storage.put_staging(
        before.staging_object_key,
        b"replacement bytes",
        content_type="text/plain",
        declared_size_bytes=len(b"replacement bytes"),
    )
    scanner = FakeMalwareScanner()

    result = process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=scanner,
        parser=DirectFileParser(),
        now=now,
    )

    assert result == "retry"
    assert scanner.scan_count == 0
    with session_factory() as session:
        upload = session.scalar(select(FileUpload).where(FileUpload.public_id == upload_id))
        assert upload is not None
        assert upload.status == FileUploadStatus.QUEUED
        assert upload.available_at == now + timedelta(seconds=30)
        assert upload.file_id is None
        assert upload.output_manifest is None
        assert session.scalar(select(FileAsset.id).where(FileAsset.user_id == user_id)) is None


class _FailingCanonicalStorage(FakeFileStorage):
    def __init__(self, *, failures_remaining: int) -> None:
        super().__init__()
        self.failures_remaining = failures_remaining

    def put_canonical(self, object_key: str, *, content: bytes, content_type: str) -> None:
        super().put_canonical(object_key, content=content, content_type=content_type)
        if self.failures_remaining > 0:
            self.failures_remaining -= 1
            raise ConnectionError("temporary write failure")


def test_manifest_is_durable_across_retries_and_terminal_failure_enqueues_cleanup(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = _FailingCanonicalStorage(failures_remaining=3)
    user_id, upload_id = _seed_queued_upload(session_factory, storage, now=now)

    assert process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(),
        parser=DirectFileParser(),
        now=now,
    ) == "retry"
    first = _upload(session_factory, upload_id)
    assert first.output_manifest is not None
    first_keys = [entry["object_key"] for entry in first.output_manifest]

    assert process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(),
        parser=DirectFileParser(),
        now=now + timedelta(seconds=31),
    ) == "retry"
    second = _upload(session_factory, upload_id)
    assert [entry["object_key"] for entry in second.output_manifest or []] == first_keys

    assert process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(),
        parser=DirectFileParser(),
        now=now + timedelta(seconds=332),
    ) == "failed"
    with session_factory() as session:
        upload = session.scalar(select(FileUpload).where(FileUpload.public_id == upload_id))
        assert upload is not None
        assert upload.status == FileUploadStatus.FAILED
        deletions = list(
            session.scalars(
                select(FileObjectDeletion).where(FileObjectDeletion.object_key.in_(first_keys))
            )
        )
        assert {row.object_key for row in deletions} == set(first_keys)
        quota = session.get(FileQuota, upload.user_id)
        assert quota is not None and quota.reserved_bytes == 0


def test_policy_rejection_is_terminal_and_releases_reserved_quota(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeFileStorage()
    user_id, upload_id = _seed_queued_upload(session_factory, storage, now=now)

    result = process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(verdict=ScanVerdict.INFECTED),
        parser=DirectFileParser(),
        now=now,
    )

    assert result == "rejected"
    with session_factory() as session:
        upload = session.scalar(select(FileUpload).where(FileUpload.public_id == upload_id))
        quota = session.get(FileQuota, user_id)
        assert upload is not None and upload.error_code == "malware_detected"
        assert quota is not None and quota.reserved_bytes == 0
        assert upload.file_id is None


class _DeactivateAfterParse:
    def __init__(self, factory: sessionmaker[Session], user_id: int) -> None:
        self._factory = factory
        self._user_id = user_id
        self._delegate = DirectFileParser()

    def parse(self, content: bytes, policy: object) -> object:
        with self._factory() as session:
            user = session.get(User, self._user_id)
            assert user is not None
            user.is_active = False
            session.commit()
        return self._delegate.parse(content, policy)  # type: ignore[arg-type]


def test_account_deactivation_wins_final_commit_and_leaves_manifest_cleanup(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeFileStorage()
    user_id, upload_id = _seed_queued_upload(session_factory, storage, now=now)

    result = process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(),
        parser=_DeactivateAfterParse(session_factory, user_id),  # type: ignore[arg-type]
        now=now,
    )

    assert result == "cancelled"
    with session_factory() as session:
        upload = session.scalar(select(FileUpload).where(FileUpload.public_id == upload_id))
        quota = session.get(FileQuota, user_id)
        assert upload is not None
        assert upload.status == FileUploadStatus.CANCELLED
        assert upload.error_code == "account_inactive"
        assert upload.file_id is None
        assert quota is not None and quota.reserved_bytes == 0
        assert upload.output_manifest is not None
        assert session.scalar(
            select(FileObjectDeletion.id).where(
                FileObjectDeletion.object_key == upload.output_manifest[0]["object_key"]
            )
        ) is not None


class _CancelAfterParse:
    def __init__(self, factory: sessionmaker[Session], upload_id: str) -> None:
        self._factory = factory
        self._upload_id = upload_id
        self._delegate = DirectFileParser()

    def parse(self, content: bytes, policy: object) -> object:
        with self._factory() as session:
            upload = session.scalar(
                select(FileUpload).where(FileUpload.public_id == self._upload_id)
            )
            assert upload is not None
            upload.status = FileUploadStatus.CANCELLED
            upload.error_code = "upload_cancelled"
            upload.completed_at = datetime.now(UTC)
            quota = session.get(FileQuota, upload.user_id)
            assert quota is not None
            quota.reserved_bytes = 0
            session.commit()
        return self._delegate.parse(content, policy)  # type: ignore[arg-type]


def test_cancel_race_cannot_create_a_file_asset(
    session_factory: sessionmaker[Session], file_settings: Settings
) -> None:
    now = datetime(2026, 8, 1, tzinfo=UTC)
    storage = FakeFileStorage()
    user_id, upload_id = _seed_queued_upload(session_factory, storage, now=now)

    result = process_upload(
        session_factory,
        upload_id=upload_id,
        settings=file_settings,
        storage=storage,
        scanner=FakeMalwareScanner(),
        parser=_CancelAfterParse(session_factory, upload_id),  # type: ignore[arg-type]
        now=now,
    )

    assert result == "cancelled"
    assert _upload(session_factory, upload_id).status == FileUploadStatus.CANCELLED
    with session_factory() as session:
        assert session.scalar(select(FileAsset.id).where(FileAsset.user_id == user_id)) is None
        assert storage.canonical == {}
