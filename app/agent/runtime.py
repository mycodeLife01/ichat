import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from app.agent.events import EventSink, RunEvent, RunEventType
from app.agent.messages import (
    ContentBlock,
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from app.agent.provider import (
    Provider,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    StreamDone,
    TextDelta,
    ToolCallDone,
)
from app.agent.tools.base import Tool, ToolRegistry, ToolResult

RunStatus = Literal["succeeded", "failed", "cancelled"]
_STREAM_ENDED = object()


class CancellationToken:
    def __init__(self) -> None:
        self._event = asyncio.Event()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()

    async def wait(self) -> None:
        await self._event.wait()


@dataclass(frozen=True)
class RunConfig:
    messages: list[Message]
    model: str
    reasoning: ReasoningConfig | None
    tools: ToolRegistry
    max_tool_calls: int
    max_provider_attempts: int


@dataclass(frozen=True)
class RunResult:
    status: RunStatus
    transcript: list[Message]
    usage: dict[str, Any] | None = None
    error: ProviderError | None = None
    provider_request_id: str | None = None


@dataclass(frozen=True)
class _Turn:
    message: Message
    done: StreamDone


@dataclass(frozen=True)
class _TurnFailure:
    error: ProviderError
    had_output: bool


class _TurnCancelled:
    pass


class AgentRunner:
    def __init__(self, provider: Provider, *, initial_seq: int = 0) -> None:
        self._provider = provider
        self._initial_seq = initial_seq

    async def run(
        self,
        config: RunConfig,
        sink: EventSink,
        cancel: CancellationToken,
    ) -> RunResult:
        if config.max_tool_calls < 0:
            raise ValueError("max_tool_calls must be non-negative")
        if config.max_provider_attempts < 1:
            raise ValueError("max_provider_attempts must be at least 1")

        messages = list(config.messages)
        transcript: list[Message] = []
        tool_calls_used = 0
        seq = self._initial_seq

        async def emit(event_type: RunEventType, payload: dict[str, Any]) -> None:
            nonlocal seq
            seq += 1
            await sink.emit(RunEvent(seq=seq, type=event_type, payload=payload))

        while True:
            if cancel.is_cancelled:
                return RunResult(status="cancelled", transcript=transcript)

            turn: _Turn | _TurnFailure | _TurnCancelled | None = None
            for attempt in range(1, config.max_provider_attempts + 1):
                turn = await self._stream_turn(
                    config=config,
                    messages=messages,
                    emit=emit,
                    cancel=cancel,
                )
                if isinstance(turn, _TurnFailure):
                    can_retry = (
                        not turn.had_output
                        and not transcript
                        and attempt < config.max_provider_attempts
                        and not cancel.is_cancelled
                    )
                    if can_retry:
                        continue
                break

            if isinstance(turn, _TurnCancelled) or cancel.is_cancelled:
                return RunResult(status="cancelled", transcript=transcript)
            if isinstance(turn, _TurnFailure):
                return RunResult(
                    status="failed",
                    transcript=transcript,
                    error=turn.error,
                )
            if turn is None:
                return RunResult(
                    status="failed",
                    transcript=transcript,
                    error=ProviderError(
                        code="runtime_error",
                        message="Agent runtime ended without a provider turn",
                    ),
                )

            tool_calls = [
                block for block in turn.message.blocks if isinstance(block, ToolCallBlock)
            ]
            if not tool_calls:
                transcript.append(turn.message)
                return RunResult(
                    status="succeeded",
                    transcript=transcript,
                    usage=turn.done.usage,
                    provider_request_id=turn.done.provider_request_id,
                )

            transcript.append(turn.message)
            messages.append(turn.message)
            tool_results: list[ToolResultBlock] = []
            for call in tool_calls:
                if cancel.is_cancelled:
                    return RunResult(status="cancelled", transcript=transcript)

                tool = config.tools.get(call.name)
                if tool is None:
                    result = _error_result(
                        "unknown_tool",
                        f"Unsupported tool: {call.name}.",
                    )
                elif tool_calls_used >= config.max_tool_calls:
                    result = _error_result(
                        "tool_call_limit",
                        "Tool call limit reached. Continuing without executing more tools.",
                    )
                else:
                    tool_calls_used += 1
                    await emit(
                        "tool_call_started",
                        {
                            "tool_name": call.name,
                            "arguments": call.arguments,
                        },
                    )
                    if cancel.is_cancelled:
                        return RunResult(status="cancelled", transcript=transcript)
                    executed = await self._execute_tool(tool, call.arguments, cancel=cancel)
                    if executed is None:
                        return RunResult(status="cancelled", transcript=transcript)
                    result = executed

                await emit(
                    "tool_call_failed" if result.is_error else "tool_call_succeeded",
                    {
                        "tool_name": call.name,
                        "metadata": dict(result.metadata),
                    },
                )
                if cancel.is_cancelled:
                    return RunResult(status="cancelled", transcript=transcript)
                tool_results.append(
                    ToolResultBlock(
                        tool_call_id=call.id,
                        content=result.content,
                        is_error=result.is_error,
                    )
                )

            result_blocks: list[ContentBlock] = list(tool_results)
            result_message = Message(role="user", blocks=result_blocks)
            transcript.append(result_message)
            messages.append(result_message)

    async def _stream_turn(
        self,
        *,
        config: RunConfig,
        messages: list[Message],
        emit: Callable[[RunEventType, dict[str, Any]], Awaitable[None]],
        cancel: CancellationToken,
    ) -> _Turn | _TurnFailure | _TurnCancelled:
        queue: asyncio.Queue[object] = asyncio.Queue()

        async def produce() -> None:
            try:
                async for event in self._provider.stream(
                    model=config.model,
                    messages=messages,
                    reasoning=config.reasoning,
                    tools=config.tools.specs() or None,
                ):
                    await queue.put(event)
            except ProviderError as exc:
                await queue.put(exc)
            except Exception as exc:
                await queue.put(
                    ProviderError(
                        code="provider_error",
                        message=str(exc) or exc.__class__.__name__,
                    )
                )
            finally:
                await queue.put(_STREAM_ENDED)

        producer_task = asyncio.create_task(produce())
        cancel_task = asyncio.create_task(cancel.wait())
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_calls: list[ToolCallBlock] = []
        had_output = False

        try:
            while True:
                next_item = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {next_item, cancel_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if cancel_task in done and cancel.is_cancelled:
                    next_item.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await next_item
                    return _TurnCancelled()

                item = await next_item
                if item is _STREAM_ENDED:
                    return _TurnFailure(
                        error=ProviderError(
                            code="no_finish",
                            message="Provider stream ended without a finish event",
                        ),
                        had_output=had_output,
                    )
                if isinstance(item, ProviderError):
                    return _TurnFailure(error=item, had_output=had_output)
                if isinstance(item, ReasoningDelta):
                    had_output = True
                    reasoning_parts.append(item.text)
                    await emit("reasoning_delta", {"text": item.text})
                elif isinstance(item, TextDelta):
                    had_output = True
                    text_parts.append(item.text)
                    await emit("text_delta", {"text": item.text})
                elif isinstance(item, ToolCallDone):
                    had_output = True
                    tool_calls.append(
                        ToolCallBlock(
                            id=item.id,
                            name=item.name,
                            arguments=item.arguments,
                        )
                    )
                elif isinstance(item, StreamDone):
                    if cancel.is_cancelled:
                        return _TurnCancelled()
                    blocks: list[ContentBlock] = []
                    reasoning = "".join(reasoning_parts)
                    content = "".join(text_parts)
                    if reasoning:
                        blocks.append(ReasoningBlock(text=reasoning))
                    if content:
                        blocks.append(TextBlock(text=content))
                    blocks.extend(tool_calls)
                    return _Turn(
                        message=Message(role="assistant", blocks=blocks),
                        done=item,
                    )
        finally:
            if not producer_task.done():
                producer_task.cancel()
            if not cancel_task.done():
                cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await producer_task
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_task

    async def _execute_tool(
        self,
        tool: Tool,
        arguments: dict[str, Any],
        *,
        cancel: CancellationToken,
    ) -> ToolResult | None:
        tool_task = asyncio.create_task(tool.execute(arguments))
        cancel_task = asyncio.create_task(cancel.wait())
        try:
            done, _ = await asyncio.wait(
                {tool_task, cancel_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_task in done and cancel.is_cancelled:
                tool_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await tool_task
                return None
            try:
                return await tool_task
            except Exception as exc:
                return _error_result(
                    "tool_execution_error",
                    str(exc) or exc.__class__.__name__,
                )
        finally:
            if not tool_task.done():
                tool_task.cancel()
            if not cancel_task.done():
                cancel_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await tool_task
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_task


def _error_result(code: str, message: str) -> ToolResult:
    return ToolResult(
        content=f"{message} ({code})",
        is_error=True,
        metadata={"error_code": code, "message": message},
    )
