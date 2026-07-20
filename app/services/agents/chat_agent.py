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

from collections.abc import AsyncIterator, Callable, Mapping
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
from app.agent.messages import ContentBlock, Message, ToolCallBlock, ToolResultBlock
from app.agent.primitives import ModelCallResult, execute_tool, stream_model_call
from app.agent.provider import Provider, ReasoningConfig
from app.agent.tools import ToolRegistry, ToolResult, WebSearchConfig, WebSearchTool
from app.core.config import Settings
from app.search import SourceRegistry, resolve_search_client
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
        assistant_metadata: Callable[[], dict[str, Any] | None],
        system_prompt: str,
    ) -> None:
        if max_tool_calls < 0:
            raise ValueError("max_tool_calls must be non-negative")
        self._provider = provider
        self._model = model
        self._reasoning = reasoning
        self._tools = tools
        self._messages = messages
        self._max_tool_calls = max_tool_calls
        self._retry_policy = retry_policy
        self._tool_backend_names = dict(tool_backend_names)
        self._assistant_metadata = assistant_metadata
        self._system_prompt = system_prompt

    @property
    def retry_policy(self) -> RetryPolicy:
        return self._retry_policy

    @property
    def tool_backend_names(self) -> dict[str, str]:
        return dict(self._tool_backend_names)

    @property
    def system_prompt(self) -> str:
        return self._system_prompt

    def assistant_metadata(self) -> dict[str, Any] | None:
        return self._assistant_metadata()

    def count_tokens(self, text: str) -> int:
        return self._provider.count_tokens(text)

    async def stream(self) -> AsyncIterator[AgentEvent]:
        """Run the agent loop once, yielding events as they occur.

        Re-entrant: all mutable state below is local, so a fresh call restarts
        a clean loop (the worker relies on this for whole-loop retry)."""
        messages = list(self._messages)
        tool_calls_used = 0

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
            tool_results: list[ToolResultBlock] = []
            for call in tool_calls:
                tool = self._tools.get(call.name)
                if tool is None:
                    result = _error_result("unknown_tool", f"Unsupported tool: {call.name}.")
                elif tool_calls_used >= self._max_tool_calls:
                    result = _error_result(
                        "tool_call_limit",
                        "Tool call limit reached. Continuing without executing more tools.",
                    )
                else:
                    tool_calls_used += 1
                    yield ToolCallStarted(tool_name=call.name, arguments=call.arguments)
                    result = await execute_tool(tool, call.arguments)
                yield ToolCallFinished(
                    tool_name=call.name,
                    is_error=result.is_error,
                    metadata=dict(result.metadata),
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
    resolve_provider: ProviderResolver = default_resolve_provider,
    now: datetime | None = None,
) -> ChatAgent:
    """Assemble a ready-to-run ``ChatAgent`` from settings + conversation history.

    This is where ``Settings`` is expanded into narrow kernel inputs: the
    provider adapter, the system prompt, the budgeted context, the tool set (with
    its ``SourceRegistry`` internalized as a closure), the tool-call limit, and
    the retry policy.
    """
    provider = resolve_provider(options.provider_name, settings=settings)
    reasoning = _reasoning_config(options.provider_options, settings)
    web_search_enabled = _web_search_enabled(options.provider_options, settings)
    system_prompt = build_system_prompt(
        settings=settings,
        web_search_enabled=web_search_enabled,
        now=now or datetime.now(UTC),
    )
    messages = build_context(
        system_prompt=system_prompt,
        history=history,
        budget_tokens=settings.context_budget_tokens,
        count_tokens=provider.count_tokens,
    )

    tools = ToolRegistry()
    tool_backend_names: dict[str, str] = {}
    sources = SourceRegistry()
    if web_search_enabled:
        search_client = resolve_search_client(settings.web_search_provider, settings=settings)
        web_search = WebSearchTool(
            config=_web_search_config(settings),
            client=search_client,
            sources=sources,
        )
        tools.register(web_search)
        tool_backend_names[web_search.name] = search_client.name

    def assistant_metadata() -> dict[str, Any] | None:
        collected = sources.all_metadata()
        return {"sources": collected} if collected else None

    return ChatAgent(
        provider=provider,
        model=options.model,
        reasoning=reasoning,
        tools=tools,
        messages=messages,
        max_tool_calls=(settings.web_search_max_tool_calls if web_search_enabled else 0),
        retry_policy=RetryPolicy(max_attempts=1 if web_search_enabled else 2),
        tool_backend_names=tool_backend_names,
        assistant_metadata=assistant_metadata,
        system_prompt=system_prompt,
    )


def _reasoning_config(options: Mapping[str, Any], settings: Settings) -> ReasoningConfig:
    """Rebuild per-run reasoning options, falling back for legacy rows."""
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
        max_source_chars=settings.web_search_max_source_chars,
        max_evidence_chars=settings.web_search_max_evidence_chars,
    )


def _error_result(code: str, message: str) -> ToolResult:
    return ToolResult(
        content=f"{message} ({code})",
        is_error=True,
        metadata={"error_code": code, "message": message},
    )
