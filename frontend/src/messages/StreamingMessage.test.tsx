import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActiveRunState } from "../runs/state";
import { StreamingMessage } from "./StreamingMessage";

function run(overrides: Partial<NonNullable<ActiveRunState>>): NonNullable<ActiveRunState> {
  return {
    runId: "1",
    conversationId: "10",
    providerName: "openai",
    latestSeq: 1,
    draftText: "",
    draftReasoning: "",
    toolState: null,
    status: "streaming",
    cancelRequested: false,
    ...overrides,
  };
}

describe("StreamingMessage", () => {
  it("shows 正在思考 before the first stream event arrives", () => {
    render(<StreamingMessage run={run({ status: "started" })} />);
    expect(screen.getByText("正在思考")).toBeInTheDocument();
  });

  it("renders streamed body text in a .body.md block", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "Hello world", status: "streaming" })} />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(container.querySelector(".body.md")).toBeTruthy();
  });

  it("keeps the streaming body in the shared assistant content column", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "Hello world" })} />,
    );

    expect(container.querySelector(".assistant-content > .assistant-markdown")).not.toBeNull();
  });

  it("rolls streamed reasoning into the header before the formal answer starts", () => {
    render(<StreamingMessage run={run({ draftReasoning: "在想", status: "streaming" })} />);
    expect(screen.getByRole("button", { name: /在想/ })).toBeInTheDocument();
    expect(screen.queryByText("正在思考")).toBeNull();
  });

  it("auto-expands DeepSeek raw reasoning behind the generic thinking label", () => {
    render(
      <StreamingMessage
        run={run({
          providerName: "deepseek",
          draftReasoning: "正在逐步推导答案",
          status: "streaming",
        })}
      />,
    );

    const header = screen.getByRole("button", { name: /正在思考/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).not.toHaveTextContent("正在逐步推导答案");
    expect(screen.getByText("正在逐步推导答案")).not.toHaveClass("hidden");
  });

  it("auto-expands recovered DeepSeek reasoning behind the thinking label", () => {
    render(
      <StreamingMessage
        run={run({
          providerName: "deepseek",
          draftReasoning: "刷新前已经生成的思考过程",
          status: "streaming",
        })}
      />,
    );

    const header = screen.getByRole("button", { name: /正在思考/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).not.toHaveTextContent("刷新前已经生成的思考过程");
    expect(screen.getByText("刷新前已经生成的思考过程")).not.toHaveClass("hidden");
  });

  it("collapses reasoning above the formal answer instead of removing it", () => {
    render(
      <StreamingMessage
        run={run({
          providerName: "deepseek",
          draftText: "正式回答",
          draftReasoning: "收起的思考",
          status: "streaming",
        })}
      />,
    );
    expect(screen.getByText("正式回答")).toBeInTheDocument();
    expect(screen.getByText("收起的思考")).toHaveClass("hidden");
    expect(screen.getByRole("button", { name: /已思考/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps reasoning visible while the first answer delta is only whitespace", () => {
    render(
      <StreamingMessage
        run={run({
          providerName: "deepseek",
          draftText: "\n",
          draftReasoning: "仍在展示的思考",
          status: "streaming",
        })}
      />,
    );

    expect(screen.getByText("仍在展示的思考")).not.toHaveClass("hidden");
    expect(screen.getByRole("button", { name: /正在思考/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("surfaces web search phases in the collapsible header and shows no preview box", () => {
    const { container, rerender } = render(
      <StreamingMessage
        run={run({
          toolState: {
            status: "running",
            tool_name: "web_search",
            query: "ja.wikipedia.org",
            message: null,
            result_count: null,
            sources: [],
          },
        })}
      />,
    );
    expect(screen.getByText("正在搜索 ja.wikipedia.org")).toBeInTheDocument();
    // The old preview box is gone.
    expect(container.querySelector(".tool-state")).toBeNull();

    rerender(
      <StreamingMessage
        run={run({
          toolState: {
            status: "succeeded",
            tool_name: "web_search",
            query: "ja.wikipedia.org",
            message: null,
            result_count: 2,
            sources: [
              { id: 1, title: "Release notes", url: "https://example.com/releases" },
              { id: 2, title: "Changelog", url: "https://example.com/changelog" },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText("已找到 2 个来源")).toBeInTheDocument();
    expect(screen.queryByText("[1] Release notes")).toBeNull();
  });

  it("lets reasoning take the header back after a tool call succeeds", () => {
    render(
      <StreamingMessage
        run={run({
          draftReasoning: "**分析来源**\n\n正在核对",
          toolState: {
            status: "succeeded",
            tool_name: "web_search",
            query: "q",
            message: null,
            result_count: 5,
            sources: [],
          },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /分析来源/ })).toBeInTheDocument();
    expect(screen.queryByText("已找到 5 个来源")).toBeNull();
  });

  it("keeps the running tool label above earlier reasoning", () => {
    render(
      <StreamingMessage
        run={run({
          draftReasoning: "**先想一下**",
          toolState: {
            status: "running",
            tool_name: "web_search",
            query: "q",
            message: null,
            result_count: null,
            sources: [],
          },
        })}
      />,
    );
    expect(screen.getByText("正在搜索 q")).toBeInTheDocument();
  });

  it("shows a persistent error status for a failed run (icon + copy, alert role)", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "部分", status: "failed" })} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("生成失败 · 请稍后重试");
    expect(alert).toHaveAttribute("data-tone", "error");
    // Color is not the only channel: an icon accompanies the copy.
    expect(container.querySelector('[data-status-icon="error"]')).toBeTruthy();
    // The partial draft stays readable next to the status.
    expect(screen.getByText("部分")).toBeInTheDocument();
  });

  it("keeps the partial answer without a status block for a cancelled run", () => {
    render(<StreamingMessage run={run({ draftText: "部分", status: "cancelled" })} />);
    expect(screen.getByText("部分")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
