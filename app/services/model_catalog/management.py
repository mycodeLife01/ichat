import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models.model_catalog import ChatModel, ModelCatalogState, ModelRoute, ModelUpstream
from app.services.model_catalog.credentials import (
    ModelCredentialCipher,
    api_key_hint,
)
from app.services.model_catalog.service import (
    ModelCatalogError,
    _database_chat_models,
    legacy_chat_models,
    provider_for_chat_model,
)

_KEY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
_ADAPTERS = frozenset({"deepseek", "openai", "openrouter"})
_TOKEN_PROFILES = frozenset({"default", "deepseek", "openai"})
_THINKING_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})
_REASONING_OUTPUTS = frozenset({"raw", "summary"})
_ADAPTER_REASONING_OUTPUTS = {
    "deepseek": frozenset({"raw"}),
    "openai": frozenset(),
    "openrouter": _REASONING_OUTPUTS,
}


@dataclass(frozen=True)
class CatalogInventory:
    database_enabled: bool
    models: tuple[ChatModel, ...]
    upstreams: tuple[ModelUpstream, ...]
    routes: tuple[ModelRoute, ...]
    selected_route_ids: frozenset[int]


async def catalog_inventory(session: AsyncSession) -> CatalogInventory:
    state = await session.get(ModelCatalogState, 1)
    models = tuple(
        (
            await session.scalars(
                select(ChatModel).order_by(ChatModel.sort_order, ChatModel.id)
            )
        ).all()
    )
    upstreams = tuple(
        (await session.scalars(select(ModelUpstream).order_by(ModelUpstream.key))).all()
    )
    routes = tuple(
        (
            await session.scalars(
                select(ModelRoute).order_by(
                    ModelRoute.chat_model_id,
                    ModelRoute.priority,
                    ModelRoute.id,
                )
            )
        ).all()
    )
    selected_route_ids = frozenset(
        model.route_id
        for model in await _database_chat_models(session)
        if model.route_id is not None
    )
    return CatalogInventory(
        database_enabled=bool(state is not None and state.database_enabled),
        models=models,
        upstreams=upstreams,
        routes=routes,
        selected_route_ids=selected_route_ids,
    )


async def set_database_catalog_enabled(
    session: AsyncSession,
    *,
    enabled: bool,
    settings: Settings,
) -> ModelCatalogState:
    state = await session.get(ModelCatalogState, 1, with_for_update=True)
    if state is None:
        state = ModelCatalogState(id=1, database_enabled=False)
        session.add(state)
        await session.flush()
    if enabled:
        models = await _database_chat_models(session)
        if not models:
            raise ModelCatalogError("Database model catalog has no available chat model routes")
        await _validate_active_routes(session, settings=settings)
        for model in models:
            provider_for_chat_model(model, settings=settings)
            if model.supports_image_input:
                _validate_vision_runtime(settings)
    state.database_enabled = enabled
    await session.flush()
    return state


async def upsert_chat_model(
    session: AsyncSession,
    *,
    key: str,
    label: str,
    thinking_levels: list[str],
    supports_image_input: bool,
    image_token_reserve: int | None,
    token_profile: str,
    sort_order: int,
    enabled: bool | None = None,
    settings: Settings | None = None,
) -> ChatModel:
    normalized_key = _validate_key(key, field="Chat model key")
    normalized_label = _required_text(label, field="Chat model label", max_length=128)
    normalized_levels = _validate_thinking_levels(thinking_levels)
    if token_profile not in _TOKEN_PROFILES:
        raise ModelCatalogError("Chat model token profile is unsupported")
    if sort_order < 0:
        raise ModelCatalogError("Chat model sort order must be non-negative")
    if supports_image_input:
        if image_token_reserve is None or image_token_reserve <= 0:
            raise ModelCatalogError("Vision chat models require a positive image token reserve")
        if settings is not None:
            _validate_vision_runtime(settings)
    else:
        image_token_reserve = None

    model = await session.scalar(select(ChatModel).where(ChatModel.key == normalized_key))
    if model is None:
        model = ChatModel(key=normalized_key, enabled=False)
        session.add(model)
    model.label = normalized_label
    model.thinking_levels = normalized_levels
    model.supports_image_input = supports_image_input
    model.image_token_reserve = image_token_reserve
    model.token_profile = token_profile
    model.sort_order = sort_order
    if enabled is not None:
        model.enabled = enabled
    await session.flush()
    return model


async def upsert_model_upstream(
    session: AsyncSession,
    *,
    key: str,
    label: str,
    adapter: str,
    base_url: str,
    api_key: str | None,
    settings: Settings,
    enabled: bool | None = None,
) -> ModelUpstream:
    normalized_key = _validate_key(key, field="Model upstream key")
    normalized_label = _required_text(label, field="Model upstream label", max_length=128)
    if adapter not in _ADAPTERS:
        raise ModelCatalogError("Model upstream adapter is unsupported")
    normalized_base_url = _validate_base_url(base_url)
    upstream = await session.scalar(
        select(ModelUpstream).where(ModelUpstream.key == normalized_key)
    )
    if upstream is None:
        if api_key is None:
            raise ModelCatalogError("A new model upstream requires an API key")
        upstream = ModelUpstream(key=normalized_key, enabled=False)
        session.add(upstream)
    if upstream.id is not None:
        routes = (
            await session.scalars(
                select(ModelRoute).where(ModelRoute.upstream_id == upstream.id)
            )
        ).all()
        for route in routes:
            _validate_reasoning_outputs(route.reasoning_outputs, adapter=adapter)
    upstream.label = normalized_label
    upstream.adapter = adapter
    upstream.base_url = normalized_base_url
    if api_key is not None:
        cipher = ModelCredentialCipher(settings.model_catalog_encryption_key)
        upstream.api_key_ciphertext = cipher.encrypt(api_key)
        upstream.api_key_hint = api_key_hint(api_key)
    if enabled is not None:
        upstream.enabled = enabled
    await session.flush()
    return upstream


async def upsert_model_route(
    session: AsyncSession,
    *,
    model_key: str,
    upstream_key: str,
    upstream_model: str,
    priority: int,
    reasoning_outputs: list[str] | None = None,
    enabled: bool | None = None,
) -> ModelRoute:
    if priority < 0:
        raise ModelCatalogError("Model route priority must be non-negative")
    model = await _chat_model_by_key(session, model_key)
    upstream = await _upstream_by_key(session, upstream_key)
    remote_model = _required_text(
        upstream_model,
        field="Upstream model id",
        max_length=256,
    )
    route = await session.scalar(
        select(ModelRoute).where(
            ModelRoute.chat_model_id == model.id,
            ModelRoute.upstream_id == upstream.id,
            ModelRoute.upstream_model == remote_model,
        )
    )
    if route is None:
        route = ModelRoute(
            chat_model_id=model.id,
            upstream_id=upstream.id,
            upstream_model=remote_model,
            enabled=False,
        )
        session.add(route)
    normalized_outputs = _validate_reasoning_outputs(
        (
            reasoning_outputs
            if reasoning_outputs is not None
            else route.reasoning_outputs
            if route.id is not None
            else ["raw"]
            if upstream.adapter == "deepseek"
            else []
        ),
        adapter=upstream.adapter,
    )
    route.priority = priority
    route.reasoning_outputs = normalized_outputs
    if enabled is not None:
        route.enabled = enabled
    await session.flush()
    return route


async def set_chat_model_enabled(
    session: AsyncSession,
    *,
    key: str,
    enabled: bool,
) -> ChatModel:
    model = await _chat_model_by_key(session, key)
    model.enabled = enabled
    await session.flush()
    return model


async def set_model_upstream_enabled(
    session: AsyncSession,
    *,
    key: str,
    enabled: bool,
) -> ModelUpstream:
    upstream = await _upstream_by_key(session, key)
    if enabled:
        routes = (
            await session.scalars(
                select(ModelRoute).where(ModelRoute.upstream_id == upstream.id)
            )
        ).all()
        for route in routes:
            _validate_reasoning_outputs(
                route.reasoning_outputs,
                adapter=upstream.adapter,
            )
    upstream.enabled = enabled
    await session.flush()
    return upstream


async def set_model_route_enabled(
    session: AsyncSession,
    *,
    model_key: str,
    upstream_key: str,
    upstream_model: str,
    enabled: bool,
) -> ModelRoute:
    model = await _chat_model_by_key(session, model_key)
    upstream = await _upstream_by_key(session, upstream_key)
    remote_model = _required_text(
        upstream_model,
        field="Upstream model id",
        max_length=256,
    )
    route = await session.scalar(
        select(ModelRoute).where(
            ModelRoute.chat_model_id == model.id,
            ModelRoute.upstream_id == upstream.id,
            ModelRoute.upstream_model == remote_model,
        )
    )
    if route is None:
        raise ModelCatalogError("Model route does not exist")
    if enabled:
        _validate_reasoning_outputs(
            route.reasoning_outputs,
            adapter=upstream.adapter,
        )
    route.enabled = enabled
    await session.flush()
    return route


async def import_environment_catalog(
    session: AsyncSession,
    *,
    settings: Settings,
) -> None:
    ModelCredentialCipher(settings.model_catalog_encryption_key)
    deepseek_upstream = await upsert_model_upstream(
        session,
        key="deepseek-official",
        label="DeepSeek Official",
        adapter="deepseek",
        base_url=settings.deepseek_base_url,
        api_key=settings.deepseek_api_key,
        settings=settings,
        enabled=True,
    )
    del deepseek_upstream
    legacy_models = legacy_chat_models(settings)
    for index, model in enumerate(
        entry for entry in legacy_models if entry.provider_name == "deepseek"
    ):
        await upsert_chat_model(
            session,
            key=model.key,
            label=model.label,
            thinking_levels=list(model.thinking_levels),
            supports_image_input=model.supports_image_input,
            image_token_reserve=model.image_token_reserve,
            token_profile=model.token_profile,
            sort_order=index,
            enabled=True,
            settings=settings,
        )
        await upsert_model_route(
            session,
            model_key=model.key,
            upstream_key="deepseek-official",
            upstream_model=model.provider_model,
            priority=0,
            reasoning_outputs=["raw"],
            enabled=True,
        )

    if not settings.openai_available:
        return
    is_openrouter = urlsplit(settings.openai_base_url).hostname == "openrouter.ai"
    upstream_key = "openrouter" if is_openrouter else "openai-official"
    adapter = "openrouter" if is_openrouter else "openai"
    await upsert_model_upstream(
        session,
        key=upstream_key,
        label="OpenRouter" if is_openrouter else "OpenAI Official",
        adapter=adapter,
        base_url=settings.openai_base_url,
        api_key=settings.openai_api_key,
        settings=settings,
        enabled=True,
    )
    offset = len(settings.deepseek_models_list)
    for index, model in enumerate(
        entry for entry in legacy_models if entry.provider_name == "openai"
    ):
        token_profile = "deepseek" if model.provider_model.startswith("deepseek/") else "openai"
        thinking_levels = (
            ["low", "high", "max"]
            if model.provider_model.startswith("deepseek/")
            else list(model.thinking_levels)
        )
        await upsert_chat_model(
            session,
            key=model.key,
            label=model.label,
            thinking_levels=thinking_levels,
            supports_image_input=model.supports_image_input,
            image_token_reserve=model.image_token_reserve,
            token_profile=token_profile,
            sort_order=offset + index,
            enabled=True,
            settings=settings,
        )
        await upsert_model_route(
            session,
            model_key=model.key,
            upstream_key=upstream_key,
            upstream_model=model.provider_model,
            priority=0,
            reasoning_outputs=["raw"] if adapter == "openrouter" else [],
            enabled=True,
        )


async def _chat_model_by_key(session: AsyncSession, key: str) -> ChatModel:
    model = await session.scalar(
        select(ChatModel).where(ChatModel.key == _validate_key(key, field="Chat model key"))
    )
    if model is None:
        raise ModelCatalogError("Chat model does not exist")
    return model


async def _upstream_by_key(session: AsyncSession, key: str) -> ModelUpstream:
    upstream = await session.scalar(
        select(ModelUpstream).where(
            ModelUpstream.key == _validate_key(key, field="Model upstream key")
        )
    )
    if upstream is None:
        raise ModelCatalogError("Model upstream does not exist")
    return upstream


def _validate_key(value: str, *, field: str) -> str:
    normalized = value.strip()
    if not _KEY_PATTERN.fullmatch(normalized):
        raise ModelCatalogError(f"{field} is invalid")
    return normalized


def _required_text(value: str, *, field: str, max_length: int | None = None) -> str:
    normalized = value.strip()
    if not normalized:
        raise ModelCatalogError(f"{field} must not be empty")
    if max_length is not None and len(normalized) > max_length:
        raise ModelCatalogError(f"{field} is too long")
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ModelCatalogError(f"{field} contains control characters")
    return normalized


def _validate_thinking_levels(levels: list[str]) -> list[str]:
    if len(levels) != len(set(levels)) or any(level not in _THINKING_LEVELS for level in levels):
        raise ModelCatalogError("Chat model thinking levels are invalid")
    return list(levels)


def _validate_reasoning_outputs(
    outputs: object,
    *,
    adapter: str,
) -> list[str]:
    if not isinstance(outputs, list) or not all(
        isinstance(output, str) for output in outputs
    ):
        raise ModelCatalogError("Model route reasoning outputs are invalid")
    if len(outputs) != len(set(outputs)) or any(
        output not in _REASONING_OUTPUTS for output in outputs
    ):
        raise ModelCatalogError("Model route reasoning outputs are invalid")
    allowed = _ADAPTER_REASONING_OUTPUTS.get(adapter)
    if allowed is None or not set(outputs).issubset(allowed):
        raise ModelCatalogError(
            "Model route reasoning outputs are unsupported by the upstream adapter"
        )
    return list(outputs)


def _validate_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or len(normalized) > 2048
    ):
        raise ModelCatalogError("Model upstream base URL is invalid")
    return normalized


async def _validate_active_routes(session: AsyncSession, *, settings: Settings) -> None:
    rows = (
        await session.execute(
            select(ModelRoute, ModelUpstream)
            .join(ChatModel, ChatModel.id == ModelRoute.chat_model_id)
            .join(ModelUpstream, ModelUpstream.id == ModelRoute.upstream_id)
            .where(
                ChatModel.enabled.is_(True),
                ModelRoute.enabled.is_(True),
                ModelUpstream.enabled.is_(True),
            )
        )
    ).all()
    cipher = ModelCredentialCipher(settings.model_catalog_encryption_key)
    for route, upstream in rows:
        _validate_base_url(upstream.base_url)
        cipher.decrypt(upstream.api_key_ciphertext)
        _validate_reasoning_outputs(
            route.reasoning_outputs,
            adapter=upstream.adapter,
        )


def _validate_vision_runtime(settings: Settings) -> None:
    base_values = (
        settings.files_r2_endpoint_url.strip(),
        settings.files_preview_bucket.strip(),
    )
    api_credentials = (
        settings.files_preview_api_access_key_id.strip(),
        settings.files_preview_api_secret_access_key.strip(),
    )
    worker_credentials = (
        settings.files_preview_llm_access_key_id.strip(),
        settings.files_preview_llm_secret_access_key.strip(),
    )
    # Compose deliberately prevents one process from holding both credential
    # pairs. The operator command therefore validates the role it runs inside;
    # deployment smoke must still cover both API admission and Worker signing.
    if not all(base_values) or not (
        all(api_credentials) or all(worker_credentials)
    ):
        raise ModelCatalogError(
            "Vision model runtime credentials are not configured for this process role"
        )
    preview = settings.files_preview_bucket.strip()
    if preview in {
        settings.files_staging_bucket.strip(),
        settings.files_canonical_bucket.strip(),
    }:
        raise ModelCatalogError("Vision preview bucket must be isolated from source buckets")
