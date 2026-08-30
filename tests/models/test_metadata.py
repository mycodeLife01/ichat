from sqlalchemy import BigInteger, CheckConstraint, Index, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID

import app.models  # noqa: F401
from app.db.base import Base

# Tables that expose an opaque external identifier alongside their bigint PK.
_PUBLIC_ID_TABLES = ("conversations", "files", "file_uploads", "runs", "messages")


def test_core_tables_are_registered() -> None:
    assert set(Base.metadata.tables) == {
        "auth_tokens",
        "avatar_deletions",
        "avatar_uploads",
        "conversations",
        "conversation_title_jobs",
        "email_outbox",
        "file_object_deletions",
        "file_objects",
        "file_quotas",
        "file_uploads",
        "files",
        "messages",
        "message_attachments",
        "model_catalog_state",
        "model_routes",
        "model_upstreams",
        "refresh_tokens",
        "run_drafts",
        "run_events",
        "run_provider_messages",
        "runs",
        "share_links",
        "chat_models",
        "users",
    }


def test_public_id_columns_are_uuid_and_unique() -> None:
    for table_name in _PUBLIC_ID_TABLES:
        public_id = Base.metadata.tables[table_name].c.public_id
        assert isinstance(public_id.type, UUID)
        assert public_id.nullable is False
        assert public_id.unique is True


def test_uuid_columns_are_limited_to_public_ids() -> None:
    # Internal identity stays on bigint; UUID is only the external handle.
    uuid_columns = {
        (table.name, column.name)
        for table in Base.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, UUID)
    }
    assert uuid_columns == {(table, "public_id") for table in _PUBLIC_ID_TABLES}


def test_primary_keys_remain_bigint() -> None:
    for table in Base.metadata.tables.values():
        for column in table.primary_key.columns:
            assert isinstance(column.type, BigInteger)


def test_users_have_case_insensitive_unique_identity_indexes() -> None:
    users = Base.metadata.tables["users"]
    index_sql = {str(index.expressions[0]) for index in users.indexes if index.unique}

    assert "lower(username)" in index_sql
    assert "lower(email)" in index_sql


def test_messages_have_linear_position_constraints() -> None:
    messages = Base.metadata.tables["messages"]

    assert isinstance(messages.c.metadata.type, JSONB)
    assert messages.c.reasoning.nullable is True
    assert messages.c.reasoning_summary.nullable is True
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
    assert isinstance(runs.c.model_config_snapshot.type, JSONB)
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
    assert isinstance(transcript.c.blocks.type, JSONB)
    assert transcript.c.blocks.nullable is True
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


def test_run_drafts_checkpoint_raw_and_summary_reasoning() -> None:
    drafts = Base.metadata.tables["run_drafts"]

    assert drafts.c.reasoning.nullable is False
    assert drafts.c.reasoning_summary.nullable is False


def test_share_links_are_bigint_token_keyed_snapshots() -> None:
    share_links = Base.metadata.tables["share_links"]

    # Token is the external handle; no public_id/UUID column here.
    assert isinstance(share_links.c.id.type, BigInteger)
    assert share_links.c.token.unique is True
    assert isinstance(share_links.c.snapshot.type, JSONB)
    assert share_links.c.snapshot.nullable is False

    conversation_fk = next(iter(share_links.c.conversation_id.foreign_keys))
    assert conversation_fk.column.table.name == "conversations"
    assert conversation_fk.ondelete == "CASCADE"


def test_auth_tokens_have_active_partial_unique_index() -> None:
    auth_tokens = Base.metadata.tables["auth_tokens"]

    assert auth_tokens.c.token_hash.unique is True
    user_fk = next(iter(auth_tokens.c.user_id.foreign_keys))
    assert user_fk.column.table.name == "users"
    assert user_fk.ondelete == "CASCADE"
    # At most one active (unused, unrevoked) token per (user, purpose).
    assert any(
        index.unique
        and [getattr(expression, "name", None) for expression in index.expressions]
        == ["user_id", "purpose"]
        and str(index.dialect_options["postgresql"]["where"])
        == "used_at IS NULL AND revoked_at IS NULL"
        for index in auth_tokens.indexes
    )


def test_email_outbox_is_jsonb_payload_queue() -> None:
    outbox = Base.metadata.tables["email_outbox"]

    assert isinstance(outbox.c.id.type, BigInteger)
    assert isinstance(outbox.c.payload.type, JSONB)
    assert outbox.c.payload.nullable is False
    # Claim/sweep scan indexes.
    index_columns = {
        tuple(column.name for column in index.columns) for index in outbox.indexes
    }
    assert ("status", "next_attempt_at") in index_columns
    assert ("locked_until",) in index_columns


def test_model_catalog_separates_models_upstreams_and_routes() -> None:
    state = Base.metadata.tables["model_catalog_state"]
    models = Base.metadata.tables["chat_models"]
    upstreams = Base.metadata.tables["model_upstreams"]
    routes = Base.metadata.tables["model_routes"]

    assert any(
        isinstance(constraint, CheckConstraint) and "id = 1" in str(constraint.sqltext)
        for constraint in state.constraints
    )
    assert isinstance(models.c.thinking_levels.type, JSONB)
    assert models.c.key.unique is True
    assert upstreams.c.key.unique is True
    assert upstreams.c.api_key_ciphertext.nullable is False
    assert "api_key" not in upstreams.c
    assert any(
        isinstance(constraint, CheckConstraint)
        and "openrouter" in str(constraint.sqltext)
        for constraint in upstreams.constraints
    )
    model_fk = next(iter(routes.c.chat_model_id.foreign_keys))
    upstream_fk = next(iter(routes.c.upstream_id.foreign_keys))
    assert model_fk.column.table.name == "chat_models"
    assert upstream_fk.column.table.name == "model_upstreams"
    assert model_fk.ondelete == "CASCADE"
    assert upstream_fk.ondelete == "RESTRICT"
    assert isinstance(routes.c.reasoning_outputs.type, JSONB)
    assert routes.c.reasoning_outputs.nullable is False
    assert any(
        isinstance(constraint, CheckConstraint)
        and "reasoning_outputs IN" in str(constraint.sqltext)
        and '[\"raw\", \"summary\"]' in str(constraint.sqltext)
        for constraint in routes.constraints
    )
