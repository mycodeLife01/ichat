"""iChat agent kernel.

A provider-neutral, DB-agnostic, transport-agnostic core for agent orchestration:

- ``messages`` — the content-block message model (the kernel's vocabulary)
- ``provider`` — the Provider protocol, streaming events, and capabilities
- ``providers`` — concrete adapters (DeepSeek on the openai SDK)
- ``tools`` — Tool protocol, registry, and the web_search tool
- ``context`` / ``prompts`` — history assembly and system-prompt building
- ``runtime`` / ``events`` — the pure orchestration loop and event sink boundary
"""

from app.agent.context import build_context
from app.agent.events import EventSink, RunEvent, RunEventType
from app.agent.messages import (
    ContentBlock,
    Message,
    ReasoningBlock,
    Role,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    assistant_text,
    system_text,
    user_text,
)
from app.agent.prompts import build_system_prompt, bundled_base_prompt
from app.agent.provider import (
    Provider,
    ProviderCapabilities,
    ProviderError,
    ReasoningConfig,
    ReasoningDelta,
    StreamDone,
    StreamEvent,
    TextDelta,
    ToolCallDone,
)
from app.agent.registry import UnknownProviderError, resolve_provider
from app.agent.runtime import (
    AgentRunner,
    CancellationToken,
    RunConfig,
    RunResult,
    RunStatus,
)
from app.agent.tools import (
    WEB_SEARCH_TOOL_SPEC,
    Tool,
    ToolRegistry,
    ToolResult,
    ToolSpec,
    WebSearchTool,
)

__all__ = [
    "WEB_SEARCH_TOOL_SPEC",
    "AgentRunner",
    "CancellationToken",
    "ContentBlock",
    "EventSink",
    "Message",
    "Provider",
    "ProviderCapabilities",
    "ProviderError",
    "ReasoningBlock",
    "ReasoningConfig",
    "ReasoningDelta",
    "Role",
    "RunConfig",
    "RunEvent",
    "RunEventType",
    "RunResult",
    "RunStatus",
    "StreamDone",
    "StreamEvent",
    "TextBlock",
    "TextDelta",
    "Tool",
    "ToolCallBlock",
    "ToolCallDone",
    "ToolRegistry",
    "ToolResult",
    "ToolResultBlock",
    "ToolSpec",
    "UnknownProviderError",
    "WebSearchTool",
    "assistant_text",
    "build_context",
    "build_system_prompt",
    "bundled_base_prompt",
    "resolve_provider",
    "system_text",
    "user_text",
]
