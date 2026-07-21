"""Tool protocol, registry, and result type for the agent kernel.

The orchestration loop dispatches model tool calls through a ``ToolRegistry``
rather than branching on hard-coded tool names, so adding a tool is writing the
tool plus registering it — no edit to the loop.

``ToolResult`` is deliberately tool-agnostic: ``content`` (what the model sees)
and ``is_error`` (whether it maps to an error tool result) are all the kernel
needs. Anything tool-specific — web_search's sources, an error code, a provider
name — rides in the free-form ``metadata`` dict, which the kernel passes through
without interpreting. No tool-specific field belongs on this type.
"""

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class ToolSpec:
    """Provider-neutral tool schema (JSON Schema ``parameters``)."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    content: str
    is_error: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class Tool(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def spec(self) -> ToolSpec: ...

    async def execute(self, arguments: dict[str, Any]) -> ToolResult: ...


class ToolRegistry:
    """Name-keyed collection of tools; the sole tool-dispatch surface."""

    def __init__(self, tools: Iterable[Tool] = ()) -> None:
        self._tools: dict[str, Tool] = {}
        for tool in tools:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def specs(self) -> list[ToolSpec]:
        return [tool.spec for tool in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools)

    def __contains__(self, name: object) -> bool:
        return name in self._tools

    def __iter__(self) -> Iterator[Tool]:
        return iter(self._tools.values())

    def __len__(self) -> int:
        return len(self._tools)
