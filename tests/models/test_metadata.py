from sqlalchemy import CheckConstraint, Index, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

import app.models  # noqa: F401
from app.db.base import Base


def test_core_tables_are_registered() -> None:
    assert set(Base.metadata.tables) == {
        "conversations",
        "email_verification_tokens",
        "messages",
        "refresh_tokens",
        "run_events",
        "run_provider_messages",
        "runs",
        "users",
    }


def test_core_schema_does_not_use_uuid_columns() -> None:
    for table in Base.metadata.tables.values():
        for column in table.columns:
            assert not isinstance(column.type, UUID)


def test_users_have_case_insensitive_unique_identity_indexes() -> None:
    users = Base.metadata.tables["users"]
    index_sql = {str(index.expressions[0]) for index in users.indexes if index.unique}

    assert "lower(username)" in index_sql
    assert "lower(email)" in index_sql


def test_messages_have_linear_position_constraints() -> None:
    messages = Base.metadata.tables["messages"]

    assert isinstance(messages.c.metadata.type, JSONB)
    assert any(
        isinstance(constraint, UniqueConstraint)
        and [column.name for column in constraint.columns] == ["conversation_id", "position"]
        for constraint in messages.constraints
    )
    assert any(
        isinstance(constraint, CheckConstraint)
        and "role IN ('user', 'assistant')" in str(constraint.sqltext)
        for constraint in messages.constraints
    )
    assert any(
        isinstance(constraint, CheckConstraint) and "position > 0" in str(constraint.sqltext)
        for constraint in messages.constraints
    )


def test_runs_have_status_constraints_and_active_run_index() -> None:
    runs = Base.metadata.tables["runs"]

    assert "system_prompt_snapshot" in runs.c
    assert any(
        isinstance(constraint, CheckConstraint)
        and "status IN" in str(constraint.sqltext)
        and "queued" in str(constraint.sqltext)
        and "cancelled" in str(constraint.sqltext)
        for constraint in runs.constraints
    )
    assert any(
        isinstance(index, Index)
        and index.unique
        and [getattr(expression, "name", None) for expression in index.expressions]
        == ["conversation_id"]
        and str(index.dialect_options["postgresql"]["where"])
        == "status IN ('queued', 'started', 'streaming', 'cancelling')"
        for index in runs.indexes
    )


def test_run_events_are_sequenced_jsonb_events() -> None:
    run_events = Base.metadata.tables["run_events"]

    assert isinstance(run_events.c.payload.type, JSONB)
    assert any(
        isinstance(constraint, UniqueConstraint)
        and [column.name for column in constraint.columns] == ["run_id", "seq"]
        for constraint in run_events.constraints
    )
    assert any(
        isinstance(constraint, CheckConstraint)
        and "type IN" in str(constraint.sqltext)
        and "text_delta" in str(constraint.sqltext)
        and "tool_call_succeeded" in str(constraint.sqltext)
        and "run_cancelled" in str(constraint.sqltext)
        for constraint in run_events.constraints
    )
    assert any(
        isinstance(constraint, CheckConstraint) and "seq > 0" in str(constraint.sqltext)
        for constraint in run_events.constraints
    )


def test_run_provider_messages_store_protocol_transcript() -> None:
    transcript = Base.metadata.tables["run_provider_messages"]

    assert isinstance(transcript.c.tool_calls.type, JSONB)
    assert isinstance(transcript.c.payload.type, JSONB)
    assert any(
        isinstance(constraint, UniqueConstraint)
        and [column.name for column in constraint.columns] == ["run_id", "seq"]
        for constraint in transcript.constraints
    )
    assert any(
        isinstance(constraint, CheckConstraint)
        and "role IN ('user', 'assistant', 'tool')" in str(constraint.sqltext)
        for constraint in transcript.constraints
    )
