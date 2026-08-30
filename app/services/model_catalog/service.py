from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, cast
from urllib.parse import urlsplit

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import ReasoningKind
from app.agent.provider import Provider
from app.agent.providers.openai import supports_reasoning_control
from app.core.config import Settings
from app.core.errors import AppError
from app.models.model_catalog import (
    ChatModel as ChatModelRow,
)
from app.models.model_catalog import ModelCatalogState, ModelRoute, ModelUpstream
from app.models.run import Run
from app.services.agents.registry import (
    ProviderAdapter,
    ProviderConnection,
    build_provider,
    resolve_provider,
)
from app.services.model_catalog.credentials import ModelCredentialCipher

UNSUPPORTED_MODEL_MESSAGE = "Requested model is not available"
NO_AVAILABLE_MODELS_MESSAGE = "No chat models are available"

_DEEPSEEK_FLASH_LEVELS = ("low", "high", "max")
_DEEPSEEK_PRO_LEVELS = ("high", "max")
_OPENAI_LEVELS = ("low", "medium", "high", "xhigh", "max")
_THINKING_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})
_TOKEN_PROFILES = frozenset({"default", "deepseek", "openai"})
_ADAPTERS = frozenset({"deepseek", "openai", "openrouter"})
_REASONING_OUTPUTS = frozenset({"raw", "summary"})
_ADAPTER_REASONING_OUTPUTS = {
    "deepseek": frozenset({"raw"}),
    "openai": frozenset(),
    "openrouter": _REASONING_OUTPUTS,
}

CatalogSource = Literal["environment", "database"]
LegacyProviderResolver = Callable[..., Provider]
TokenCounter = Callable[[str], int]


class ModelCatalogError(Exception):
    """A stable, secret-free catalog or route configuration failure."""


@dataclass(frozen=True)
class ChatModel:
    key: str
    label: str
    thinking_levels: tuple[str, ...]
    reasoning_outputs: tuple[ReasoningKind, ...]
    supports_image_input: bool
    image_token_reserve: int | None
    token_profile: str
    provider_name: str
    provider_model: str
    upstream_key: str
    base_url: str
    source: CatalogSource
    route_id: int | None = None
    api_key_ciphertext: str | None = field(default=None, repr=False, compare=False)

    @property
    def supports_reasoning(self) -> bool:
        return bool(self.thinking_levels)

    def snapshot(self) -> dict[str, Any] | None:
        if self.source == "environment":
            return None
        assert self.route_id is not None
        return {
            "version": 2,
            "catalog_model": self.key,
            "route_id": self.route_id,
            "upstream": self.upstream_key,
            "adapter": self.provider_name,
            "base_url": self.base_url,
            "provider_model": self.provider_model,
            "thinking_levels": list(self.thinking_levels),
            "reasoning_outputs": list(self.reasoning_outputs),
            "supports_image_input": self.supports_image_input,
            "image_token_reserve": self.image_token_reserve,
            "token_profile": self.token_profile,
        }


@dataclass(frozen=True)
class RunModelRuntime:
    provider: Provider
    supports_reasoning: bool
    reasoning_outputs: tuple[ReasoningKind, ...]
    supports_image_input: bool
    image_token_reserve: int
    # The run's project model code (the catalog key), never the upstream model.
    catalog_model: str


async def available_chat_models(
    session: AsyncSession,
    *,
    settings: Settings,
) -> list[ChatModel]:
    if not await database_catalog_enabled(session):
        return legacy_chat_models(settings)
    return await _database_chat_models(session)


async def resolve_chat_model(
    session: AsyncSession,
    *,
    settings: Settings,
    requested_model: str | None,
) -> ChatModel:
    models = await available_chat_models(session, settings=settings)
    if requested_model is None:
        if not models:
            raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, NO_AVAILABLE_MODELS_MESSAGE)
        return models[0]
    for entry in models:
        if entry.key == requested_model:
            return entry
    raise AppError(status.HTTP_422_UNPROCESSABLE_ENTITY, UNSUPPORTED_MODEL_MESSAGE)


def provider_for_chat_model(model: ChatModel, *, settings: Settings) -> Provider:
    if model.source == "environment":
        return resolve_provider(model.provider_name, settings=settings)
    if model.api_key_ciphertext is None:
        raise ModelCatalogError("Model upstream credential is unavailable")
    cipher = ModelCredentialCipher(settings.model_catalog_encryption_key)
    api_key = cipher.decrypt(model.api_key_ciphertext)
    return build_provider(
        ProviderConnection(
            adapter=_provider_adapter(model.provider_name),
            api_key=api_key,
            base_url=model.base_url,
            token_profile=model.token_profile,
            default_thinking_enabled=settings.deepseek_thinking_enabled,
            default_reasoning_effort=settings.deepseek_reasoning_effort,
            reasoning_outputs=model.reasoning_outputs,
        )
    )


def token_counter_for_chat_model(model: ChatModel, *, settings: Settings) -> TokenCounter:
    """Return the model's configured estimator without exposing Provider to API routes."""
    return provider_for_chat_model(model, settings=settings).count_tokens


async def resolve_run_model_runtime(
    session: AsyncSession,
    *,
    run: Run,
    settings: Settings,
    legacy_resolver: LegacyProviderResolver = resolve_provider,
) -> RunModelRuntime:
    raw = run.model_config_snapshot
    if raw is None:
        model = next(
            (
                entry
                for entry in legacy_chat_models(settings)
                if entry.provider_name == run.provider_name
                and entry.provider_model == run.provider_model
            ),
            None,
        )
        provider = legacy_resolver(run.provider_name, settings=settings)
        persisted_reserve = (run.provider_options or {}).get("image_token_reserve")
        legacy_reserve = model.image_token_reserve if model is not None else None
        image_token_reserve = (
            persisted_reserve
            if isinstance(persisted_reserve, int)
            and not isinstance(persisted_reserve, bool)
            and persisted_reserve >= 0
            else legacy_reserve or 0
        )
        return RunModelRuntime(
            provider=provider,
            supports_reasoning=model.supports_reasoning if model is not None else True,
            reasoning_outputs=(model.reasoning_outputs if model is not None else ("raw",)),
            supports_image_input=(
                model.supports_image_input if model is not None else image_token_reserve > 0
            ),
            image_token_reserve=image_token_reserve,
            # Environment-mode catalog keys equal the provider model string.
            catalog_model=run.provider_model,
        )

    if not isinstance(raw, Mapping):
        raise ModelCatalogError("Run model route snapshot is invalid")
    snapshot = _parse_snapshot(raw)
    if snapshot["adapter"] != run.provider_name or snapshot["provider_model"] != run.provider_model:
        raise ModelCatalogError("Run model route snapshot does not match persisted provider fields")
    upstream = await session.scalar(
        select(ModelUpstream).where(ModelUpstream.key == snapshot["upstream"])
    )
    if upstream is None:
        raise ModelCatalogError("Run model upstream no longer exists")
    cipher = ModelCredentialCipher(settings.model_catalog_encryption_key)
    provider = build_provider(
        ProviderConnection(
            adapter=_provider_adapter(snapshot["adapter"]),
            api_key=cipher.decrypt(upstream.api_key_ciphertext),
            base_url=snapshot["base_url"],
            token_profile=snapshot["token_profile"],
            default_thinking_enabled=settings.deepseek_thinking_enabled,
            default_reasoning_effort=settings.deepseek_reasoning_effort,
            reasoning_outputs=snapshot["reasoning_outputs"],
        )
    )
    return RunModelRuntime(
        provider=provider,
        supports_reasoning=bool(snapshot["thinking_levels"]),
        reasoning_outputs=snapshot["reasoning_outputs"],
        supports_image_input=snapshot["supports_image_input"],
        image_token_reserve=snapshot["image_token_reserve"] or 0,
        catalog_model=snapshot["catalog_model"],
    )


async def database_catalog_enabled(session: AsyncSession) -> bool:
    state = await session.get(ModelCatalogState, 1)
    return bool(state is not None and state.database_enabled)


def legacy_chat_models(settings: Settings) -> list[ChatModel]:
    models = [
        ChatModel(
            key=model,
            label=_display_label(model),
            thinking_levels=_deepseek_levels(model),
            reasoning_outputs=("raw",),
            supports_image_input=False,
            image_token_reserve=None,
            token_profile="deepseek",
            provider_name="deepseek",
            provider_model=model,
            upstream_key="deepseek-env",
            base_url=settings.deepseek_base_url,
            source="environment",
        )
        for model in settings.deepseek_models_list
    ]
    if settings.openai_available:
        vision_models = set(settings.openai_vision_models_list)
        models.extend(
            ChatModel(
                key=model,
                label=_display_label(model),
                thinking_levels=_openai_levels(model),
                reasoning_outputs=(
                    ("raw",)
                    if urlsplit(settings.openai_base_url).hostname == "openrouter.ai"
                    else ()
                ),
                supports_image_input=model in vision_models,
                image_token_reserve=(
                    settings.openai_image_token_reserve if model in vision_models else None
                ),
                token_profile="openai",
                provider_name="openai",
                provider_model=model,
                upstream_key="openai-env",
                base_url=settings.openai_base_url,
                source="environment",
            )
            for model in settings.openai_models_list
        )
    return models


async def _database_chat_models(session: AsyncSession) -> list[ChatModel]:
    rows = (
        await session.execute(
            select(ChatModelRow, ModelRoute, ModelUpstream)
            .join(ModelRoute, ModelRoute.chat_model_id == ChatModelRow.id)
            .join(ModelUpstream, ModelUpstream.id == ModelRoute.upstream_id)
            .where(
                ChatModelRow.enabled.is_(True),
                ModelRoute.enabled.is_(True),
                ModelUpstream.enabled.is_(True),
            )
            .order_by(
                ChatModelRow.sort_order.asc(),
                ChatModelRow.id.asc(),
                ModelRoute.priority.asc(),
                ModelRoute.id.asc(),
            )
        )
    ).all()
    selected: list[ChatModel] = []
    seen_models: set[int] = set()
    for model, route, upstream in rows:
        if model.id in seen_models:
            continue
        if model.supports_image_input and upstream.adapter == "deepseek":
            continue
        selected.append(_database_model(model, route, upstream))
        seen_models.add(model.id)
    return selected


def _database_model(
    model: ChatModelRow,
    route: ModelRoute,
    upstream: ModelUpstream,
) -> ChatModel:
    thinking_levels = _validated_thinking_levels(model.thinking_levels)
    reasoning_outputs = _validated_reasoning_outputs(
        route.reasoning_outputs,
        adapter=upstream.adapter,
    )
    if model.token_profile not in _TOKEN_PROFILES:
        raise ModelCatalogError("Chat model token profile is unsupported")
    _provider_adapter(upstream.adapter)
    return ChatModel(
        key=model.key,
        label=model.label,
        thinking_levels=thinking_levels,
        reasoning_outputs=reasoning_outputs,
        supports_image_input=model.supports_image_input,
        image_token_reserve=model.image_token_reserve,
        token_profile=model.token_profile,
        provider_name=upstream.adapter,
        provider_model=route.upstream_model,
        upstream_key=upstream.key,
        base_url=upstream.base_url,
        source="database",
        route_id=route.id,
        api_key_ciphertext=upstream.api_key_ciphertext,
    )


def _parse_snapshot(raw: Mapping[str, Any]) -> dict[str, Any]:
    version = raw.get("version")
    if version not in (1, 2):
        raise ModelCatalogError("Run model route snapshot version is unsupported")
    required_strings = (
        "catalog_model",
        "upstream",
        "adapter",
        "base_url",
        "provider_model",
        "token_profile",
    )
    parsed: dict[str, Any] = {"version": version}
    for snapshot_field in required_strings:
        value = raw.get(snapshot_field)
        if not isinstance(value, str) or not value:
            raise ModelCatalogError("Run model route snapshot is invalid")
        parsed[snapshot_field] = value
    route_id = raw.get("route_id")
    if isinstance(route_id, bool) or not isinstance(route_id, int) or route_id <= 0:
        raise ModelCatalogError("Run model route snapshot is invalid")
    parsed["route_id"] = route_id
    parsed["thinking_levels"] = _validated_thinking_levels(raw.get("thinking_levels"))
    if version == 1:
        parsed["reasoning_outputs"] = (
            ("raw",) if parsed["adapter"] == "deepseek" else ()
        )
    else:
        parsed["reasoning_outputs"] = _validated_reasoning_outputs(
            raw.get("reasoning_outputs"),
            adapter=parsed["adapter"],
        )
    supports_image_input = raw.get("supports_image_input")
    if not isinstance(supports_image_input, bool):
        raise ModelCatalogError("Run model route snapshot is invalid")
    parsed["supports_image_input"] = supports_image_input
    reserve = raw.get("image_token_reserve")
    if reserve is not None and (
        isinstance(reserve, bool) or not isinstance(reserve, int) or reserve <= 0
    ):
        raise ModelCatalogError("Run model route snapshot is invalid")
    if supports_image_input != (reserve is not None):
        raise ModelCatalogError("Run model route snapshot image capability is inconsistent")
    parsed["image_token_reserve"] = reserve
    if parsed["token_profile"] not in _TOKEN_PROFILES:
        raise ModelCatalogError("Run model route snapshot token profile is unsupported")
    _provider_adapter(parsed["adapter"])
    return parsed


def _provider_adapter(value: str) -> ProviderAdapter:
    if value not in _ADAPTERS:
        raise ModelCatalogError("Model upstream adapter is unsupported")
    return cast(ProviderAdapter, value)


def _validated_thinking_levels(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ModelCatalogError("Chat model thinking levels are invalid")
    levels = tuple(raw)
    if len(levels) != len(set(levels)) or any(level not in _THINKING_LEVELS for level in levels):
        raise ModelCatalogError("Chat model thinking levels are invalid")
    return levels


def _validated_reasoning_outputs(
    raw: object,
    *,
    adapter: str | None = None,
) -> tuple[ReasoningKind, ...]:
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ModelCatalogError("Model route reasoning outputs are invalid")
    outputs = tuple(raw)
    if len(outputs) != len(set(outputs)) or any(
        output not in _REASONING_OUTPUTS for output in outputs
    ):
        raise ModelCatalogError("Model route reasoning outputs are invalid")
    if adapter is not None:
        allowed = _ADAPTER_REASONING_OUTPUTS.get(adapter)
        if allowed is None or not set(outputs).issubset(allowed):
            raise ModelCatalogError(
                "Model route reasoning outputs are unsupported by the upstream adapter"
            )
    return cast(tuple[ReasoningKind, ...], outputs)


def _display_label(model: str) -> str:
    return model.rsplit("/", 1)[-1]


def _deepseek_levels(model: str) -> tuple[str, ...]:
    if _display_label(model).endswith("-pro"):
        return _DEEPSEEK_PRO_LEVELS
    return _DEEPSEEK_FLASH_LEVELS


def _openai_levels(model: str) -> tuple[str, ...]:
    if supports_reasoning_control(model):
        return _OPENAI_LEVELS
    return ()
