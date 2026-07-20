"""Agent orchestration layer — the owner of the agent loop.

Assembles provider/prompt/context/tools/policy and runs the model-call → tool
dispatch loop, yielding neutral ``AgentEvent``s. Corresponds to LangChain's
harness (``create_agent``). Depends on the kernel (``app/agent``), ``app/core``,
and ``app/search``; never reads the database or touches transport/persistence.
"""

from app.services.agents.chat_agent import (
    ChatAgent,
    ChatAgentOptions,
    ProviderResolver,
    RetryPolicy,
    build_chat_agent,
)
from app.services.agents.context import build_context
from app.services.agents.prompts import build_system_prompt, bundled_base_prompt
from app.services.agents.registry import UnknownProviderError, resolve_provider

__all__ = [
    "ChatAgent",
    "ChatAgentOptions",
    "ProviderResolver",
    "RetryPolicy",
    "UnknownProviderError",
    "build_chat_agent",
    "build_context",
    "build_system_prompt",
    "bundled_base_prompt",
    "resolve_provider",
]
