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
