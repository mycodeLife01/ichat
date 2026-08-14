import os
from collections.abc import Iterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from celery.exceptions import Retry
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.agent import ProviderError
from app.core.config import get_settings
from app.db.sync_session import create_sync_engine
from app.models.conversation import Conversation, Message
from app.models.files import MessageAttachment
from app.models.run import ConversationTitleJob, Run
from app.models.user import User
from app.tasks.llm_tasks import (
    _load_title_inputs,
    generate_conversation_title,
    sweep_conversation_title_jobs,
)

TEST_EMAIL_DOMAIN = "llm-task-test.example.com"


@pytest.fixture()
def session_factory() -> Iterator[sessionmaker[Session]]:
    settings = get_settings().model_copy(
        update={
            "database_url": os.environ.get(
                "LLM_TASK_TEST_DATABASE_URL",
                "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
            )
        }
    )
    engine = create_sync_engine(settings)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        _clean_test_data(session)
        session.commit()
    yield factory
    with factory() as session:
        _clean_test_data(session)
        session.commit()
    engine.dispose()


def _clean_test_data(session: Session) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}"))
    conversation_ids = select(Conversation.id).where(Conversation.user_id.in_(user_ids))
    session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    session.execute(delete(User).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")))


def _seed_succeeded_turn(factory: sessionmaker[Session], *, title: str | None = None) -> int:
    suffix = uuid4().hex
    with factory() as session:
        user = User(
            username=f"llm-task-{suffix}",
            email=f"llm-task-{suffix}@{TEST_EMAIL_DOMAIN}",
            password_hash="hash",
            email_verified=False,
            is_active=True,
        )
        session.add(user)
        session.flush()
        conversation = Conversation(
            user_id=user.id,
            title=title,
            activated_at=datetime.now(UTC),
        )
        session.add(conversation)
        session.flush()
        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content="Plan a backend",
            position=1,
        )
        session.add(user_message)
        session.flush()
        run = Run(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="fake",
            provider_model="fake-model",
        )
        session.add(run)
        session.flush()
        user_message.run_id = run.id
        session.add(
            Message(
                conversation_id=conversation.id,
                run_id=run.id,
                role="assistant",
                content="Start with the state machine",
                position=2,
            )
        )
        session.add(
            ConversationTitleJob(
                run_id=run.id,
                conversation_id=conversation.id,
                status="pending",
            )
        )
        session.commit()
        return run.id


def _seed_second_succeeded_run(factory: sessionmaker[Session], *, first_run_id: int) -> int:
    with factory() as session:
        first_run = session.get(Run, first_run_id)
        assert first_run is not None
        user_message = Message(
            conversation_id=first_run.conversation_id,
            role="user",
            content="Another question",
            position=3,
        )
        session.add(user_message)
        session.flush()
        run = Run(
            conversation_id=first_run.conversation_id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="fake",
            provider_model="fake-model",
        )
        session.add(run)
        session.flush()
        user_message.run_id = run.id
        session.add(
            Message(
                conversation_id=first_run.conversation_id,
                run_id=run.id,
                role="assistant",
                content="Another answer",
                position=4,
            )
        )
        session.commit()
        return run.id


def test_generate_conversation_title_updates_null_title(
    session_factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _seed_succeeded_turn(session_factory)
    _seed_second_succeeded_run(session_factory, first_run_id=run_id)
    with session_factory() as session:
        run = session.get(Run, run_id)
        assert run is not None
        user_message = session.get(Message, run.user_message_id)
        assistant = session.scalar(
            select(Message).where(Message.run_id == run_id, Message.role == "assistant")
        )
        assert user_message is not None and assistant is not None
        archived_at = datetime.now(UTC)
        user_message.archived_at = archived_at
        assistant.archived_at = archived_at
        session.commit()

    class FakeTitleAgent:
        def generate(
            self,
            *,
            user_content: str,
            assistant_content: str,
            attachment_metadata: str | None = None,
        ) -> str:
            assert user_content == "Plan a backend"
            assert assistant_content == "Start with the state machine"
            assert attachment_metadata is None
            return "Backend Plan"

    monkeypatch.setattr("app.tasks.llm_tasks.get_sync_session_factory", lambda: session_factory)
    monkeypatch.setattr("app.tasks.llm_tasks.build_title_agent", lambda **kwargs: FakeTitleAgent())

    assert generate_conversation_title.run(run_id) == "updated"

    with session_factory() as session:
        run = session.get(Run, run_id)
        assert run is not None
        conversation = session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title == "Backend Plan"
        job = session.get(ConversationTitleJob, run_id)
        assert job is not None
        assert job.status == "completed"


def test_generate_conversation_title_skips_manual_title(
    session_factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _seed_succeeded_turn(session_factory, title="Manual title")
    monkeypatch.setattr("app.tasks.llm_tasks.get_sync_session_factory", lambda: session_factory)
    monkeypatch.setattr(
        "app.tasks.llm_tasks.build_title_agent",
        lambda **kwargs: pytest.fail("title agent should not be built"),
    )

    assert generate_conversation_title.run(run_id) == "skipped"


def test_title_inputs_include_only_attachment_safe_metadata(
    session_factory: sessionmaker[Session],
) -> None:
    run_id = _seed_succeeded_turn(session_factory)
    with session_factory() as session:
        run = session.get(Run, run_id)
        assert run is not None
        session.add(
            MessageAttachment(
                message_id=run.user_message_id,
                file_id=None,
                position=0,
                name="agenda.txt",
                media_type="text/plain",
                size_bytes=321,
            )
        )
        session.commit()

        inputs = _load_title_inputs(session, run_id=run_id)

    assert inputs is not None
    assert inputs.attachment_metadata == (
        '[{"name":"agenda.txt","media_type":"text/plain","size_bytes":321}]'
    )
    assert "document body" not in (inputs.attachment_metadata or "")


def test_generate_conversation_title_skips_when_success_is_not_first(
    session_factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    first_run_id = _seed_succeeded_turn(session_factory)
    run_id = _seed_second_succeeded_run(session_factory, first_run_id=first_run_id)
    monkeypatch.setattr("app.tasks.llm_tasks.get_sync_session_factory", lambda: session_factory)
    monkeypatch.setattr(
        "app.tasks.llm_tasks.build_title_agent",
        lambda **kwargs: pytest.fail("title agent should not be built"),
    )

    assert generate_conversation_title.run(run_id) == "skipped"


def test_title_job_sweep_keeps_job_pending_when_broker_publish_fails(
    session_factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _seed_succeeded_turn(session_factory)
    monkeypatch.setattr("app.tasks.llm_tasks.get_sync_session_factory", lambda: session_factory)

    def fail_publish(*, args: list[int]) -> None:
        assert args == [run_id]
        raise ConnectionError("broker unavailable")

    monkeypatch.setattr(generate_conversation_title, "apply_async", fail_publish)

    assert sweep_conversation_title_jobs.run() == 1
    with session_factory() as session:
        job = session.get(ConversationTitleJob, run_id)
        assert job is not None
        assert job.status == "pending"


def test_generate_conversation_title_retries_provider_failure(
    session_factory: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _seed_succeeded_turn(session_factory)

    class FailingTitleAgent:
        def generate(
            self,
            *,
            user_content: str,
            assistant_content: str,
            attachment_metadata: str | None = None,
        ) -> str:
            del user_content, assistant_content, attachment_metadata
            raise ProviderError(code="summary_failed", message="boom")

    retry_call: dict[str, object] = {}

    def retry(**kwargs: object) -> Retry:
        retry_call.update(kwargs)
        return Retry("retry title")

    monkeypatch.setattr("app.tasks.llm_tasks.get_sync_session_factory", lambda: session_factory)
    monkeypatch.setattr(
        "app.tasks.llm_tasks.build_title_agent",
        lambda **kwargs: FailingTitleAgent(),
    )
    monkeypatch.setattr(generate_conversation_title, "retry", retry)

    with pytest.raises(Retry):
        generate_conversation_title.run(run_id)

    assert retry_call["countdown"] == 5
    assert retry_call["max_retries"] == 3
