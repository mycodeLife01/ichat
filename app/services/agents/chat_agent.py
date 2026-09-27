"""The agent loop's owner — the orchestration layer's ``ChatAgent``.

This is iChat's analogue of LangChain's harness (``create_agent``): it assembles
the provider, prompt, budgeted context, tools, and policy, then runs the model
call → tool dispatch loop, yielding neutral ``AgentEvent``s upward. The worker
consumes those events and engineers them (seq, sink, retry, cancel, DB); the
kernel below provides the single-call primitives. Future middleware, HITL, and
conditional tool routing grow here.

**The generator is the boundary**: ``stream()`` only *declares* events. It knows
nothing of runs, seq numbers, sinks, persistence, or cancellation (it is only
cancel-safe). Every mutable loop variable is local to ``stream()``, so the agent
instance holds only the immutable assembly result and each ``stream()`` call is
an independent, re-entrant loop.
"""

import asyncio
import time
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.agent.events import (
    AgentEvent,
    AgentFinal,
    MessageDone,
    ToolCallFinished,
    ToolCallStarted,
)
from app.agent.messages import ContentBlock, ImageBlock, Message, ToolCallBlock, ToolResultBlock
from app.agent.primitives import ModelCallResult, execute_tool, stream_model_call
from app.agent.provider import ImageInputResolver, Provider, ProviderError, ReasoningConfig
from app.agent.tools import Tool, ToolRegistry, ToolResult, WebSearchConfig, WebSearchTool
from app.core.config import Settings
from app.search import SourceRegistry
from app.search.registry import resolve_search_client
from app.services.agents.context import build_context
from app.services.agents.prompts import build_system_prompt
from app.services.agents.registry import resolve_provider as default_resolve_provider

ProviderResolver = Callable[..., Provider]


@dataclass(frozen=True)
class RetryPolicy:
    """Declarative retry rule (data, not behavior). The worker classifies a
    failed model call's ``ProviderError.code`` against this and re-runs the loop;
    ``retryable_codes = None`` means every code is retryable."""

    max_attempts: int
    retryable_codes: frozenset[str] | None = None

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")

    def is_retryable(self, code: str) -> bool:
        return self.retryable_codes is None or code in self.retryable_codes


@dataclass(frozen=True)
class ChatAgentOptions:
    """Per-run selectors read from the persisted ``Run`` row."""

    provider_name: str
    model: str
    provider_options: Mapping[str, Any] = field(default_factory=dict)
    image_token_reserve: int = 0
    supports_reasoning: bool | None = None
    supports_image_input: bool | None = None
    # The project model code injected into the system prompt. Falls back to
    # ``model`` when unset (environment-mode keys equal the provider model).
    catalog_model: str | None = None


class ChatAgent:
    def __init__(
        self,
        *,
        provider: Provider,
        model: str,
        reasoning: ReasoningConfig | None,
        tools: ToolRegistry,
        messages: list[Message],
        max_tool_calls: int,
        retry_policy: RetryPolicy,
        tool_backend_names: Mapping[str, str],
        assistant_metadata: Callable[[str], dict[str, Any] | None],
        system_prompt: str,
        image_resolver: ImageInputResolver | None = None,
        image_token_reserve: int = 0,
        max_tool_concurrency: int = 4,
    ) -> None:
        if max_tool_calls < 0:
            raise ValueError("max_tool_calls must be non-negative")
        if max_tool_concurrency < 1:
            raise ValueError("max_tool_concurrency must be at least 1")
        self._provider = provider
        self._model = model
        self._reasoning = reasoning
        self._tools = tools
        self._messages = messages
        self._max_tool_calls = max_tool_calls
        self._max_tool_concurrency = max_tool_concurrency
        self._retry_policy = retry_policy
        self._tool_backend_names = dict(tool_backend_names)
        self._assistant_metadata = assistant_metadata
        self._system_prompt = system_prompt
        self._image_resolver = image_resolver
        self._image_count = sum(
            isinstance(block, ImageBlock) for message in messages for block in message.blocks
        )
        self._image_token_reserve = max(image_token_reserve, 0)

    @property
    def retry_policy(self) -> RetryPolicy:
        return self._retry_policy

    @property
    def tool_backend_names(self) -> dict[str, str]:
        return dict(self._tool_backend_names)

    @property
    def system_prompt(self) -> str:
        return self._system_prompt

    @property
    def provider_name(self) -> str:
        return self._provider.name

    @property
    def model(self) -> str:
        return self._model

    @property
    def image_count(self) -> int:
        return self._image_count

    @property
    def image_token_reserve(self) -> int:
        return self._image_token_reserve

    def assistant_metadata(self, text: str) -> dict[str, Any] | None:
        """Metadata for the materialized answer; ``text`` is its final content."""
        return self._assistant_metadata(text)

    def count_tokens(self, text: str) -> int:
        return self._provider.count_tokens(text)

    async def stream(self) -> AsyncIterator[AgentEvent]:
        """Run the agent loop once, yielding events as they occur.

        Re-entrant: all mutable state below is local, so a fresh call restarts
        a clean loop (the worker relies on this for whole-loop retry)."""
        messages = list(self._messages)
        tool_calls_used = 0
        semaphore = asyncio.Semaphore(self._max_tool_concurrency)

        while True:
            message: Message | None = None
            usage: dict[str, Any] | None = None
            provider_request_id: str | None = None
            async for item in stream_model_call(
                self._provider,
                model=self._model,
                messages=messages,
                reasoning=self._reasoning,
                tools=self._tools.specs() or None,
                image_resolver=self._image_resolver,
            ):
                if isinstance(item, ModelCallResult):
                    message = item.message
                    usage = item.usage
                    provider_request_id = item.provider_request_id
                else:
                    yield item

            assert message is not None  # stream_model_call raises otherwise
            yield MessageDone(message)

            tool_calls = [block for block in message.blocks if isinstance(block, ToolCallBlock)]
            if not tool_calls:
                yield AgentFinal(usage=usage, provider_request_id=provider_request_id)
                return

            messages.append(message)
            # Admission is decided in call order before anything runs, so which
            # calls execute depends only on the model's order, never on timing.
            rejected: dict[int, ToolResult] = {}
            admitted: list[tuple[int, Tool]] = []
            for index, call in enumerate(tool_calls):
                tool = self._tools.get(call.name)
                if tool is None:
                    rejected[index] = _error_result(
                        "unknown_tool", f"Unsupported tool: {call.name}."
                    )
                elif tool_calls_used >= self._max_tool_calls:
                    rejected[index] = _error_result(
                        "tool_call_limit",
                        "Tool call limit reached. Continuing without executing more tools.",
                    )
                else:
                    tool_calls_used += 1
                    admitted.append((index, tool))

            for index, _tool in admitted:
                call = tool_calls[index]
                yield ToolCallStarted(
                    tool_name=call.name,
                    arguments=call.arguments,
                    batch_size=len(admitted),
                )
            outcomes = await asyncio.gather(
                *(
                    _timed_execute(tool, tool_calls[index].arguments, semaphore)
                    for index, tool in admitted
                )
            )
            executed = {
                index: outcome for (index, _tool), outcome in zip(admitted, outcomes, strict=True)
            }

            # Every Finished of a concurrent batch carries the batch's total, so
            # the header never shows one call's count before settling on another.
            batch_source_count = (
                _distinct_source_count(result for result, _elapsed in outcomes)
                if len(admitted) > 1
                else None
            )
            # Finished events wait for the whole batch and follow call order:
            # emitting in completion order would report success while sibling
            # calls are still running.
            tool_results: list[ToolResultBlock] = []
            for index, call in enumerate(tool_calls):
                if index in executed:
                    result, elapsed_ms = executed[index]
                else:
                    result, elapsed_ms = rejected[index], None
                yield ToolCallFinished(
                    tool_name=call.name,
                    is_error=result.is_error,
                    metadata=dict(result.metadata),
                    elapsed_ms=elapsed_ms,
                    batch_source_count=batch_source_count,
                )
                tool_results.append(
                    ToolResultBlock(
                        tool_call_id=call.id,
                        content=result.content,
                        is_error=result.is_error,
                    )
                )

            result_blocks: list[ContentBlock] = list(tool_results)
            result_message = Message(role="user", blocks=result_blocks)
            yield MessageDone(result_message)
            messages.append(result_message)


def build_chat_agent(
    *,
    settings: Settings,
    history: list[Message],
    options: ChatAgentOptions,
    provider: Provider | None = None,
    resolve_provider: ProviderResolver = default_resolve_provider,
    now: datetime | None = None,
    image_resolver: ImageInputResolver | None = None,
    prior_sources: Sequence[Mapping[str, Any]] = (),
) -> ChatAgent:
    """Assemble a ready-to-run ``ChatAgent`` from settings + conversation history.

    This is where ``Settings`` is expanded into narrow kernel inputs: the
    provider adapter, the system prompt, the budgeted context, the tool set (with
    its ``SourceRegistry`` internalized as a closure), the tool-call limit, and
    the retry policy.
    """
    resolved_provider = provider or resolve_provider(options.provider_name, settings=settings)
    supports_image_input = (
        options.supports_image_input
        if options.supports_image_input is not None
        else options.provider_name == "openai"
        and options.model in settings.openai_vision_models_list
    )
    if _contains_image_block(history) and not supports_image_input:
        raise ProviderError(
            code=f"{options.provider_name}_image_input_not_supported",
            message="This model does not support image input",
        )

    supports_reasoning = (
        options.supports_reasoning
        if options.supports_reasoning is not None
        else resolved_provider.capabilities.supports_reasoning
    )
    reasoning = _reasoning_config(
        options.provider_options,
        settings,
        supports_reasoning=supports_reasoning,
    )
    web_search_enabled = _web_search_enabled(options.provider_options, settings)
    system_prompt = build_system_prompt(
        settings=settings,
        web_search_enabled=web_search_enabled,
        now=now or datetime.now(UTC),
        catalog_model=options.catalog_model or options.model,
    )
    messages = build_context(
        system_prompt=system_prompt,
        history=history,
        budget_tokens=settings.context_budget_tokens,
        count_tokens=resolved_provider.count_tokens,
        image_token_reserve=max(options.image_token_reserve, 0),
    )

    tools = ToolRegistry()
    tool_backend_names: dict[str, str] = {}
    # Seeded with earlier turns' sources so citation ids stay unique across the
    # conversation and an answer can re-cite a source from a previous turn.
    sources = SourceRegistry(prior_sources)
    if web_search_enabled:
        search_client = resolve_search_client(settings.web_search_provider, settings=settings)
        web_search = WebSearchTool(
            config=_web_search_config(settings),
            client=search_client,
            sources=sources,
        )
        tools.register(web_search)
        tool_backend_names[web_search.name] = search_client.name

    def assistant_metadata(text: str) -> dict[str, Any] | None:
        collected = sources.assistant_sources(text)
        return {"sources": collected} if collected else None

    return ChatAgent(
        provider=resolved_provider,
        model=options.model,
        reasoning=reasoning,
        tools=tools,
        messages=messages,
        max_tool_calls=(settings.web_search_max_tool_calls if web_search_enabled else 0),
        max_tool_concurrency=settings.tool_call_max_concurrency,
        retry_policy=RetryPolicy(max_attempts=1 if web_search_enabled else 2),
        tool_backend_names=tool_backend_names,
        assistant_metadata=assistant_metadata,
        system_prompt=system_prompt,
        image_resolver=image_resolver,
        image_token_reserve=options.image_token_reserve,
    )


def _reasoning_config(
    options: Mapping[str, Any],
    settings: Settings,
    *,
    supports_reasoning: bool,
) -> ReasoningConfig | None:
    """Rebuild per-run reasoning options, falling back for legacy rows."""
    if not supports_reasoning:
        # ``None`` means "use provider default" to the DeepSeek adapter, which
        # could re-enable thinking. An empty thinking-level catalog is an
        # explicit model-level off switch, so carry that intent to every adapter.
        return ReasoningConfig(
            enabled=False,
            effort=settings.deepseek_reasoning_effort,
        )
    return ReasoningConfig(
        enabled=bool(options.get("thinking_enabled", settings.deepseek_thinking_enabled)),
        effort=str(options.get("reasoning_effort", settings.deepseek_reasoning_effort)),
    )


def _web_search_enabled(options: Mapping[str, Any], settings: Settings) -> bool:
    return bool(options.get("web_search_enabled", False)) and settings.web_search_available


def _web_search_config(settings: Settings) -> WebSearchConfig:
    return WebSearchConfig(
        provider=settings.web_search_provider,
        available=settings.web_search_available,
        default_max_results=settings.web_search_default_max_results,
        max_extract_results=settings.web_search_max_extract_results,
        extract_timeout_seconds=settings.web_search_extract_timeout_seconds,
        total_timeout_seconds=settings.web_search_total_timeout_seconds,
        max_source_chars=settings.web_search_max_source_chars,
        max_evidence_chars=settings.web_search_max_evidence_chars,
    )


def _contains_image_block(messages: list[Message]) -> bool:
    return any(isinstance(block, ImageBlock) for message in messages for block in message.blocks)


async def _timed_execute(
    tool: Tool, arguments: dict[str, Any], semaphore: asyncio.Semaphore
) -> tuple[ToolResult, int]:
    """Run one tool under the per-run concurrency cap; the elapsed time excludes
    waiting for a slot, so it is the call's own latency."""
    async with semaphore:
        started = time.monotonic()
        result = await execute_tool(tool, arguments)
        return result, round((time.monotonic() - started) * 1000)


def _distinct_source_count(results: Iterable[ToolResult]) -> int:
    """Count sources across successful results by citation id; the registry
    reuses an id when two searches return the same URL."""
    ids: set[object] = set()
    for result in results:
        sources = result.metadata.get("sources")
        if result.is_error or not isinstance(sources, list):
            continue
        ids.update(source.get("id") for source in sources if isinstance(source, dict))
    return len(ids)


def _error_result(code: str, message: str) -> ToolResult:
    return ToolResult(
        content=f"{message} ({code})",
        is_error=True,
        metadata={"error_code": code, "message": message},
    )
