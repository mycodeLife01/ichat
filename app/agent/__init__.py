"""iChat agent kernel — provider-neutral, DB-agnostic, transport-agnostic
project-level agent building blocks.

Contents:

- ``messages`` — the content-block message model (the kernel's vocabulary)
- ``provider`` — the Provider protocol, streaming events, and capabilities
- ``providers`` — concrete adapters (DeepSeek on the openai SDK; narrow params)
- ``tools`` — Tool protocol, registry, and the web_search tool
- ``primitives`` — ``stream_model_call`` / ``execute_tool`` single-call primitives
- ``events`` — the ``AgentEvent`` vocabulary yielded by the orchestration loop

The agent loop and business assembly live one layer up in ``app/services/agents``;
history loading, seq, sinks, the run state machine, and cancellation are the
worker's. The kernel imports no ``app.core.config``, no DB/ORM, and no
``app/services``.
"""

from app.agent.events import (
    AgentEvent,
    AgentFinal,
    MessageDone,
    ToolCallFinished,
    ToolCallStarted,
)
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
from app.agent.primitives import ModelCallResult, execute_tool, stream_model_call
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
from app.agent.tools import (
    WEB_SEARCH_TOOL_SPEC,
    Tool,
    ToolRegistry,
    ToolResult,
    ToolSpec,
    WebSearchConfig,
    WebSearchTool,
)

__all__ = [
    "WEB_SEARCH_TOOL_SPEC",
    "AgentEvent",
    "AgentFinal",
    "ContentBlock",
    "Message",
    "MessageDone",
    "ModelCallResult",
    "Provider",
    "ProviderCapabilities",
    "ProviderError",
    "ReasoningBlock",
    "ReasoningConfig",
    "ReasoningDelta",
    "Role",
    "StreamDone",
    "StreamEvent",
    "TextBlock",
    "TextDelta",
    "Tool",
    "ToolCallBlock",
    "ToolCallDone",
    "ToolCallFinished",
    "ToolCallStarted",
    "ToolRegistry",
    "ToolResult",
    "ToolResultBlock",
    "ToolSpec",
    "WebSearchConfig",
    "WebSearchTool",
    "assistant_text",
    "execute_tool",
    "stream_model_call",
    "system_text",
    "user_text",
]
