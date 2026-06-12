import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActiveRunState } from "../runs/state";
import { StreamingMessage } from "./StreamingMessage";

function run(overrides: Partial<NonNullable<ActiveRunState>>): NonNullable<ActiveRunState> {
  return {
    runId: 1,
    conversationId: 10,
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
  it("renders streamed body text in a .body.md block", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "Hello world", status: "streaming" })} />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(container.querySelector(".body.md")).toBeTruthy();
  });

  it("renders the reasoning block", () => {
    render(<StreamingMessage run={run({ draftReasoning: "在想", status: "streaming" })} />);
    expect(screen.getByText("在想")).toBeInTheDocument();
  });

  it("renders running and succeeded web search tool states", () => {
    const { rerender } = render(
      <StreamingMessage
        run={run({
          toolState: {
            status: "running",
            tool_name: "web_search",
            query: "latest iChat release",
            message: null,
            result_count: null,
            sources: [],
          },
        })}
      />,
    );
    expect(screen.getByText("正在搜索网页...")).toBeInTheDocument();
    expect(screen.getByText("latest iChat release")).toBeInTheDocument();

    rerender(
      <StreamingMessage
        run={run({
          toolState: {
            status: "succeeded",
            tool_name: "web_search",
            query: "latest iChat release",
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
    expect(screen.getByText("[1] Release notes")).toBeInTheDocument();
    expect(screen.getByText("[2] Changelog")).toBeInTheDocument();
  });

  it("shows the failed status-pill (demo copy)", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "部分", status: "failed" })} />,
    );
    expect(container.querySelector(".status-pill.failed")).toBeTruthy();
    expect(screen.getByText("生成失败 · 请稍后重试")).toBeInTheDocument();
  });

  it("shows the stopped status-pill (demo copy)", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "部分", status: "cancelled" })} />,
    );
    expect(container.querySelector(".status-pill.stopped")).toBeTruthy();
    expect(screen.getByText("已停止")).toBeInTheDocument();
  });
});
