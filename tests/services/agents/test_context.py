"""Pure, in-memory tests for the DB-free kernel context assembler."""

from app.agent.messages import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
    assistant_text,
    user_text,
)
from app.services.agents.context import build_context


def test_build_context_prepends_system() -> None:
    history = [
        user_text("first user"),
        assistant_text("first assistant"),
        user_text("second user"),
    ]

    messages = build_context(
        system_prompt="Be brief.",
        history=history,
        budget_tokens=10_000,
        count_tokens=len,
    )

    assert [m.role for m in messages] == ["system", "user", "assistant", "user"]
    assert [m.text() for m in messages] == [
        "Be brief.",
        "first user",
        "first assistant",
        "second user",
    ]


def test_build_context_trims_oldest_whole_turns_over_budget() -> None:
    history = [
        user_text("oldest" * 50),
        assistant_text("middle" * 50),
        user_text("newest" * 5),
    ]

    messages = build_context(
        system_prompt="sys",
        history=history,
        budget_tokens=100,
        count_tokens=len,
    )

    assert messages[0] == Message(role="system", blocks=[TextBlock("sys")])
    assert messages[-1].text() == "newest" * 5
    # The whole oldest turn (user + assistant) is dropped, never split.
    assert all("oldest" * 50 not in m.text() for m in messages)
    assert all("middle" * 50 not in m.text() for m in messages)


def test_build_context_keeps_at_least_the_last_turn() -> None:
    history = [user_text("huge" * 1000)]

    messages = build_context(
        system_prompt="sys",
        history=history,
        budget_tokens=1,
        count_tokens=len,
    )

    # Never trim below one turn even when it alone blows the budget.
    assert [m.role for m in messages] == ["system", "user"]


def test_build_context_never_splits_a_tool_turn() -> None:
    tool_turn = [
        user_text("latest docs?"),
        Message(
            role="assistant",
            blocks=[
                ReasoningBlock("need docs"),
                ToolCallBlock(id="call_1", name="web_search", arguments={"q": "docs"}),
            ],
        ),
        Message(role="user", blocks=[ToolResultBlock("call_1", "Evidence [1]")]),
        assistant_text("Final [1]"),
    ]
    history = [user_text("padding" * 100), *tool_turn]

    messages = build_context(
        system_prompt="sys",
        history=history,
        budget_tokens=200,
        count_tokens=len,
    )

    roles = [m.role for m in messages]
    # Padding turn dropped; the tool turn survives intact (call + result together),
    # and trimming never cuts between the assistant tool call and its tool result.
    assert roles == ["system", "user", "assistant", "user", "assistant"]
    assert isinstance(messages[2].blocks[1], ToolCallBlock)
    assert messages[3].blocks == [ToolResultBlock("call_1", "Evidence [1]")]
