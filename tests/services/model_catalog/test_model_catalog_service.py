import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.agent.providers.glm import GLMProvider
from app.agent.providers.openrouter import OpenRouterProvider
from app.core.config import Settings, get_settings
from app.models.model_catalog import ChatModel, ModelCatalogState, ModelRoute, ModelUpstream
from app.models.run import Run
from app.services.model_catalog import (
    ModelCatalogConflictError,
    ModelCatalogError,
    available_chat_models,
    provider_for_chat_model,
    resolve_run_model_runtime,
)
from app.services.model_catalog.credentials import ModelCredentialCipher
from app.services.model_catalog.management import (
    archive_chat_model,
    archive_model_route,
    archive_model_upstream,
    catalog_ref,
    restore_archived,
    set_database_catalog_enabled,
    set_model_route_enabled,
    upsert_chat_model,
    upsert_model_route,
    upsert_model_upstream,
)

TEST_DATABASE_URL = os.environ.get(
    "MODEL_CATALOG_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)


@pytest.fixture()
async def session() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    async with engine.connect() as connection:
        transaction = await connection.begin()
        session = AsyncSession(bind=connection, expire_on_commit=False)
        await session.execute(update(ChatModel).values(enabled=False))
        await session.execute(update(ModelRoute).values(enabled=False))
        await session.execute(update(ModelUpstream).values(enabled=False))
        state = await session.get(ModelCatalogState, 1)
        if state is None:
            state = ModelCatalogState(id=1, database_enabled=False)
            session.add(state)
        else:
            state.database_enabled = False
        await session.flush()
        try:
            yield session
        finally:
            await session.close()
            await transaction.rollback()
    await engine.dispose()


@pytest.fixture()
def settings() -> Settings:
    return get_settings().model_copy(
        update={"model_catalog_encryption_key": ModelCredentialCipher.generate_key()}
    )


async def _configure_two_routes(session: AsyncSession, settings: Settings) -> None:
    await upsert_chat_model(
        session,
        key="deepseek-v4",
        label="DeepSeek V4",
        thinking_levels=["low", "high", "max"],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="deepseek",
        sort_order=0,
        enabled=True,
        settings=settings,
    )
    await upsert_model_upstream(
        session,
        key="deepseek-official-test",
        label="DeepSeek Official",
        adapter="deepseek",
        base_url="https://api.deepseek.test/v1",
        api_key="sk-deepseek-secret",
        enabled=True,
        settings=settings,
    )
    await upsert_model_upstream(
        session,
        key="openrouter-test",
        label="OpenRouter",
        adapter="openrouter",
        base_url="https://openrouter.test/api/v1",
        api_key="sk-openrouter-secret",
        enabled=True,
        settings=settings,
    )
    await upsert_model_route(
        session,
        model_key="deepseek-v4",
        upstream_key="deepseek-official-test",
        upstream_model="deepseek-chat",
        priority=20,
        reasoning_outputs=["raw"],
        enabled=True,
    )
    await upsert_model_route(
        session,
        model_key="deepseek-v4",
        upstream_key="openrouter-test",
        upstream_model="deepseek/deepseek-chat",
        priority=10,
        reasoning_outputs=["raw", "summary"],
        enabled=True,
    )


async def test_database_catalog_switches_same_model_upstream_without_restart(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await set_database_catalog_enabled(session, enabled=True, settings=settings)

    before = await available_chat_models(session, settings=settings)
    assert [(model.key, model.upstream_key) for model in before] == [
        ("deepseek-v4", "openrouter-test")
    ]
    assert before[0].reasoning_outputs == ("raw", "summary")

    await set_model_route_enabled(
        session,
        model_key="deepseek-v4",
        upstream_key="openrouter-test",
        upstream_model="deepseek/deepseek-chat",
        enabled=False,
    )
    after = await available_chat_models(session, settings=settings)

    assert [(model.key, model.upstream_key) for model in after] == [
        ("deepseek-v4", "deepseek-official-test")
    ]

    await upsert_chat_model(
        session,
        key="deepseek-v4",
        label="DeepSeek V4 Updated",
        thinking_levels=["low", "high", "max"],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="deepseek",
        sort_order=0,
        settings=settings,
    )
    edited = await available_chat_models(session, settings=settings)
    assert edited[0].label == "DeepSeek V4 Updated"


async def test_deepseek_route_serves_a_vision_model_declared_by_the_catalog(
    session: AsyncSession,
    settings: Settings,
) -> None:
    # Vision is a chat-model property, not an adapter one: a DeepSeek route is
    # served when the model declares image input, and vice versa.
    settings = settings.model_copy(
        update={
            "files_r2_endpoint_url": "https://account.r2.cloudflarestorage.com",
            "files_staging_bucket": "staging",
            "files_canonical_bucket": "canonical",
            "files_preview_bucket": "preview",
            "files_preview_api_access_key_id": "preview-api-key",
            "files_preview_api_secret_access_key": "preview-api-secret",
        }
    )
    await upsert_chat_model(
        session,
        key="deepseek-vision",
        label="DeepSeek Vision",
        thinking_levels=["low", "high", "max"],
        supports_image_input=True,
        image_token_reserve=8192,
        token_profile="deepseek",
        sort_order=0,
        enabled=True,
        settings=settings,
    )
    await upsert_model_upstream(
        session,
        key="deepseek-vision-upstream",
        label="DeepSeek Official",
        adapter="deepseek",
        base_url="https://api.deepseek.test/v1",
        api_key="sk-deepseek-secret",
        enabled=True,
        settings=settings,
    )
    await upsert_model_route(
        session,
        model_key="deepseek-vision",
        upstream_key="deepseek-vision-upstream",
        upstream_model="deepseek-v4-flash-vision-exp",
        priority=10,
        reasoning_outputs=["raw"],
        enabled=True,
    )
    await set_database_catalog_enabled(session, enabled=True, settings=settings)

    models = await available_chat_models(session, settings=settings)

    assert [(model.key, model.upstream_key) for model in models] == [
        ("deepseek-vision", "deepseek-vision-upstream")
    ]
    assert models[0].supports_image_input is True
    assert models[0].image_token_reserve == 8192


async def test_run_snapshot_keeps_selected_route_after_catalog_edits(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await set_database_catalog_enabled(session, enabled=True, settings=settings)
    selected = (await available_chat_models(session, settings=settings))[0]
    snapshot = selected.snapshot()
    assert snapshot is not None
    assert "api_key_ciphertext" not in snapshot
    assert snapshot["version"] == 2
    assert snapshot["reasoning_outputs"] == ["raw", "summary"]

    selected_upstream = await session.scalar(
        select(ModelUpstream).where(ModelUpstream.key == "openrouter-test")
    )
    assert selected_upstream is not None
    selected_upstream.adapter = "openai"
    selected_upstream.base_url = "https://changed.example/v1"
    await session.flush()
    run = Run(
        provider_name=selected.provider_name,
        provider_model=selected.provider_model,
        model_config_snapshot=snapshot,
    )

    runtime = await resolve_run_model_runtime(session, run=run, settings=settings)

    assert isinstance(runtime.provider, OpenRouterProvider)
    assert runtime.supports_reasoning is True
    assert runtime.reasoning_outputs == ("raw", "summary")
    assert runtime.supports_image_input is False


@pytest.mark.parametrize(
    ("upstream_key", "upstream_model", "outputs"),
    [
        ("deepseek-official-test", "deepseek-chat", ["summary"]),
        ("openrouter-test", "deepseek/deepseek-chat", ["raw", "raw"]),
        ("openrouter-test", "deepseek/deepseek-chat", ["unknown"]),
    ],
)
async def test_route_rejects_invalid_or_adapter_incompatible_reasoning_outputs(
    session: AsyncSession,
    settings: Settings,
    upstream_key: str,
    upstream_model: str,
    outputs: list[str],
) -> None:
    await _configure_two_routes(session, settings)

    with pytest.raises(ModelCatalogError):
        await upsert_model_route(
            session,
            model_key="deepseek-v4",
            upstream_key=upstream_key,
            upstream_model=upstream_model,
            priority=10,
            reasoning_outputs=outputs,
        )


async def test_upstream_adapter_change_revalidates_existing_route_outputs(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)

    with pytest.raises(ModelCatalogError) as exc:
        await upsert_model_upstream(
            session,
            key="openrouter-test",
            label="OpenAI Compatible",
            adapter="openai",
            base_url="https://api.openai.test/v1",
            api_key=None,
            settings=settings,
        )

    assert "unsupported by the upstream adapter" in str(exc.value)


async def test_glm_route_defaults_to_raw_outputs_and_resolves_glm_provider(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await upsert_chat_model(
        session,
        key="glm-5.3",
        label="GLM 5.3",
        thinking_levels=["low", "high", "max"],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="default",
        sort_order=30,
        enabled=True,
        settings=settings,
    )
    await upsert_model_upstream(
        session,
        key="glm-test",
        label="GLM Official",
        adapter="glm",
        base_url="https://open.bigmodel.test/api/paas/v4",
        api_key="sk-glm-secret",
        enabled=True,
        settings=settings,
    )
    await upsert_model_route(
        session,
        model_key="glm-5.3",
        upstream_key="glm-test",
        upstream_model="glm-5.3",
        priority=10,
        enabled=True,
    )
    await set_database_catalog_enabled(session, enabled=True, settings=settings)

    models = await available_chat_models(session, settings=settings)
    assert [model.key for model in models] == ["glm-5.3"]
    assert models[0].reasoning_outputs == ("raw",)
    assert isinstance(provider_for_chat_model(models[0], settings=settings), GLMProvider)


async def test_glm_route_rejects_summary_reasoning_outputs(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await upsert_chat_model(
        session,
        key="glm-5.3",
        label="GLM 5.3",
        thinking_levels=["low", "high", "max"],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="default",
        sort_order=30,
        settings=settings,
    )
    await upsert_model_upstream(
        session,
        key="glm-test",
        label="GLM Official",
        adapter="glm",
        base_url="https://open.bigmodel.test/api/paas/v4",
        api_key="sk-glm-secret",
        settings=settings,
    )

    with pytest.raises(ModelCatalogError):
        await upsert_model_route(
            session,
            model_key="glm-5.3",
            upstream_key="glm-test",
            upstream_model="glm-5.3",
            priority=10,
            reasoning_outputs=["summary"],
        )


async def test_upstream_credentials_are_encrypted_at_rest(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    upstream = await session.scalar(
        select(ModelUpstream).where(ModelUpstream.key == "openrouter-test")
    )
    assert upstream is not None

    assert upstream.api_key_ciphertext.startswith("fernet:v1:")
    assert "sk-openrouter-secret" not in upstream.api_key_ciphertext
    assert upstream.api_key_hint == "…cret"


async def _selected_run(session: AsyncSession, settings: Settings) -> Run:
    selected = (await available_chat_models(session, settings=settings))[0]
    return Run(
        provider_name=selected.provider_name,
        provider_model=selected.provider_model,
        model_config_snapshot=selected.snapshot(),
    )


async def _archive_openrouter_route(session: AsyncSession) -> None:
    await archive_model_route(
        session,
        model_key="deepseek-v4",
        upstream_key="openrouter-test",
        upstream_model="deepseek/deepseek-chat",
    )


async def _chat_model_row(session: AsyncSession, key: str) -> ChatModel:
    model = await session.scalar(
        select(ChatModel).where(ChatModel.key == key, ChatModel.archived_at.is_(None))
    )
    assert model is not None
    return model


async def _routes_of(session: AsyncSession, model: ChatModel) -> dict[str, ModelRoute]:
    routes = (
        await session.scalars(select(ModelRoute).where(ModelRoute.chat_model_id == model.id))
    ).all()
    return {route.upstream_model: route for route in routes}


async def test_archived_items_leave_the_available_catalog(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await set_database_catalog_enabled(session, enabled=True, settings=settings)

    await _archive_openrouter_route(session)
    after_route = await available_chat_models(session, settings=settings)
    assert [(model.key, model.upstream_key) for model in after_route] == [
        ("deepseek-v4", "deepseek-official-test")
    ]

    await archive_chat_model(session, key="deepseek-v4")
    assert await available_chat_models(session, settings=settings) == []


async def test_old_run_keeps_archived_upstream_credentials_after_key_is_recreated(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await set_database_catalog_enabled(session, enabled=True, settings=settings)
    old_run = await _selected_run(session, settings)
    assert old_run.model_config_snapshot is not None
    assert old_run.model_config_snapshot["upstream"] == "openrouter-test"

    await _archive_openrouter_route(session)
    await archive_model_upstream(session, key="openrouter-test")
    await upsert_model_upstream(
        session,
        key="openrouter-test",
        label="OpenRouter Rebuilt",
        adapter="openrouter",
        base_url="https://openrouter.test/api/v1",
        api_key="sk-rebuilt-secret",
        enabled=True,
        settings=settings,
    )
    await upsert_model_route(
        session,
        model_key="deepseek-v4",
        upstream_key="openrouter-test",
        upstream_model="deepseek/deepseek-chat",
        priority=10,
        reasoning_outputs=["raw", "summary"],
        enabled=True,
    )
    rows = await session.scalar(
        select(func.count()).where(ModelUpstream.key == "openrouter-test")
    )
    assert rows == 2

    old_runtime = await resolve_run_model_runtime(session, run=old_run, settings=settings)
    new_runtime = await resolve_run_model_runtime(
        session,
        run=await _selected_run(session, settings),
        settings=settings,
    )

    assert isinstance(old_runtime.provider, OpenRouterProvider)
    assert old_runtime.provider._api_key == "sk-openrouter-secret"
    assert isinstance(new_runtime.provider, OpenRouterProvider)
    assert new_runtime.provider._api_key == "sk-rebuilt-secret"


async def test_run_snapshot_rejects_route_that_reaches_a_different_upstream(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await set_database_catalog_enabled(session, enabled=True, settings=settings)
    run = await _selected_run(session, settings)
    assert run.model_config_snapshot is not None
    run.model_config_snapshot = {**run.model_config_snapshot, "upstream": "deepseek-official-test"}

    with pytest.raises(ModelCatalogError, match="does not match its upstream"):
        await resolve_run_model_runtime(session, run=run, settings=settings)


async def test_upstream_archive_is_blocked_by_unarchived_routes_even_when_disabled(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await set_model_route_enabled(
        session,
        model_key="deepseek-v4",
        upstream_key="openrouter-test",
        upstream_model="deepseek/deepseek-chat",
        enabled=False,
    )

    with pytest.raises(ModelCatalogConflictError) as exc:
        await archive_model_upstream(session, key="openrouter-test")

    assert "deepseek-v4 -> openrouter-test -> deepseek/deepseek-chat" in str(exc.value)


async def test_model_archive_cascades_and_restore_returns_only_that_batch(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    model = await _chat_model_row(session, "deepseek-v4")
    await archive_model_route(
        session,
        model_key="deepseek-v4",
        upstream_key="deepseek-official-test",
        upstream_model="deepseek-chat",
    )

    await archive_chat_model(session, key="deepseek-v4")
    routes = await _routes_of(session, model)
    assert model.archived_at is not None
    assert routes["deepseek/deepseek-chat"].archived_at == model.archived_at
    assert routes["deepseek-chat"].archived_at is not None
    assert routes["deepseek-chat"].archived_at != model.archived_at

    await restore_archived(session, ref=catalog_ref(model))

    assert model.archived_at is None
    assert routes["deepseek/deepseek-chat"].archived_at is None
    assert routes["deepseek-chat"].archived_at is not None


async def test_model_restore_keeps_routes_of_archived_upstreams_archived(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    model = await _chat_model_row(session, "deepseek-v4")
    await archive_chat_model(session, key="deepseek-v4")
    await archive_model_upstream(session, key="openrouter-test")

    await restore_archived(session, ref=catalog_ref(model))

    routes = await _routes_of(session, model)
    assert routes["deepseek-chat"].archived_at is None
    assert routes["deepseek/deepseek-chat"].archived_at is not None


async def test_upsert_creates_a_new_row_instead_of_resurrecting_an_archived_one(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    archived = await _chat_model_row(session, "deepseek-v4")
    await archive_chat_model(session, key="deepseek-v4")

    await upsert_chat_model(
        session,
        key="deepseek-v4",
        label="DeepSeek V4 Rebuilt",
        thinking_levels=[],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="deepseek",
        sort_order=0,
        settings=settings,
    )

    active = await _chat_model_row(session, "deepseek-v4")
    assert active.id != archived.id
    assert archived.archived_at is not None
    assert archived.label == "DeepSeek V4"


async def test_upstream_edits_ignore_archived_routes(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    await _archive_openrouter_route(session)

    # The archived route declares raw+summary, which the openai adapter rejects.
    upstream = await upsert_model_upstream(
        session,
        key="openrouter-test",
        label="OpenAI Compatible",
        adapter="openai",
        base_url="https://api.openai.test/v1",
        api_key=None,
        settings=settings,
    )

    assert upstream.adapter == "openai"


async def test_restore_rejects_conflicting_or_unarchived_items(
    session: AsyncSession,
    settings: Settings,
) -> None:
    await _configure_two_routes(session, settings)
    model = await _chat_model_row(session, "deepseek-v4")
    routes = await _routes_of(session, model)
    openrouter_route = routes["deepseek/deepseek-chat"]

    with pytest.raises(ModelCatalogConflictError, match="not archived"):
        await restore_archived(session, ref=catalog_ref(model))

    # Same route target recreated while the old route is archived.
    await _archive_openrouter_route(session)
    await upsert_model_route(
        session,
        model_key="deepseek-v4",
        upstream_key="openrouter-test",
        upstream_model="deepseek/deepseek-chat",
        priority=10,
        reasoning_outputs=["raw"],
    )
    with pytest.raises(ModelCatalogConflictError, match="same target"):
        await restore_archived(session, ref=catalog_ref(openrouter_route))

    # A route cannot come back under an archived parent.
    await archive_chat_model(session, key="deepseek-v4")
    with pytest.raises(ModelCatalogConflictError, match="chat model and upstream"):
        await restore_archived(session, ref=catalog_ref(openrouter_route))

    # The same model key recreated while the old model is archived.
    await upsert_chat_model(
        session,
        key="deepseek-v4",
        label="DeepSeek V4 Rebuilt",
        thinking_levels=[],
        supports_image_input=False,
        image_token_reserve=None,
        token_profile="deepseek",
        sort_order=0,
        settings=settings,
    )
    with pytest.raises(ModelCatalogConflictError, match="same key"):
        await restore_archived(session, ref=catalog_ref(model))

    upstream = await session.scalar(
        select(ModelUpstream).where(ModelUpstream.key == "openrouter-test")
    )
    assert upstream is not None
    await archive_model_upstream(session, key="openrouter-test")
    await upsert_model_upstream(
        session,
        key="openrouter-test",
        label="OpenRouter Rebuilt",
        adapter="openrouter",
        base_url="https://openrouter.test/api/v1",
        api_key="sk-rebuilt-secret",
        settings=settings,
    )
    with pytest.raises(ModelCatalogConflictError, match="same key"):
        await restore_archived(session, ref=catalog_ref(upstream))

    with pytest.raises(ModelCatalogError, match="reference is invalid"):
        await restore_archived(session, ref="model-abc")
