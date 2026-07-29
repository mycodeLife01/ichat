import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MessageResponse } from "../api/types";
import { MessageThread } from "./MessageThread";

const messages: MessageResponse[] = [
  {
    id: "1", conversation_id: "10", run_id: null, role: "user",
    content: "问题", reasoning: null, position: 1, created_at: "2026-06-08T10:00:00Z",
  },
  {
    id: "2", conversation_id: "10", run_id: "100", role: "assistant",
    content: "答案", reasoning: null, position: 2, created_at: "2026-06-08T10:00:01Z",
  },
];

describe("MessageThread", () => {
  it("renders all messages", () => {
    render(<MessageThread messages={messages} />);
    expect(screen.getByText("问题")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("renders a pending user message without message actions", () => {
    render(<MessageThread messages={[]} pendingMessage="刚刚发送的问题" />);
    expect(screen.getByText("刚刚发送的问题")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /复制|编辑并重发/ })).toBeNull();
  });

  it("reserves action-bar height under the pending bubble on desktop only", () => {
    const { container, rerender } = render(
      <MessageThread messages={[]} pendingMessage="刚刚发送的问题" />,
    );
    expect(
      container.querySelector('[data-state="pending"] .msg-actions'),
    ).not.toBeNull();

    rerender(<MessageThread messages={[]} pendingMessage="刚刚发送的问题" isMobile />);
    expect(
      container.querySelector('[data-state="pending"] .msg-actions'),
    ).toBeNull();
  });

  it("passes isMobile down: assistant actions resident, user actions behind long-press", () => {
    render(<MessageThread messages={messages} isMobile />);
    // The assistant bar renders resident copy/regenerate; the user message
    // shows no action button (its sheet opens via long-press on the bubble).
    expect(screen.getByRole("button", { name: /重新生成/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /复制/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
  });
});
