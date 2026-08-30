import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.agent.providers.openrouter import OpenRouterProvider
from app.core.config import Settings, get_settings
from app.models.model_catalog import ChatModel, ModelCatalogState, ModelRoute, ModelUpstream
from app.models.run import Run
from app.services.model_catalog import (
    ModelCatalogError,
    available_chat_models,
    resolve_run_model_runtime,
)
from app.services.model_catalog.credentials import ModelCredentialCipher
from app.services.model_catalog.management import (
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
