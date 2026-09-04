import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const pendingMessage: MessageResponse = {
  id: "client-submission-1",
  conversation_id: "10",
  run_id: null,
  role: "user",
  content: "刚刚发送的问题",
  reasoning: null,
  position: 3,
  created_at: "2026-06-08T10:00:02Z",
};

afterEach(() => {
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
});

describe("MessageThread", () => {
  it("uses viewport width inside the mobile thread scrollport", () => {
    const { container } = render(<MessageThread messages={messages} />);

    expect(container.querySelector(".thread-inner")).toHaveClass(
      "max-[760px]:[.thread-region_&]:w-screen",
    );
  });

  it("renders all messages", () => {
    render(<MessageThread messages={messages} />);
    expect(screen.getByText("问题")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("offers 询问Piko only after a valid selection stays stable for 100ms", async () => {
    vi.useFakeTimers();
    const onReplyQuote = vi.fn();
    render(
      <MessageThread
        messages={messages}
        conversationId="10"
        onReplyQuote={onReplyQuote}
      />,
    );
    const answer = screen.getByText("答案");
    const range = document.createRange();
    range.selectNodeContents(answer);
    Object.defineProperty(range, "getClientRects", {
      value: () => [{ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(99));
    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));

    const action = screen.getByRole("button", { name: "询问Piko" });
    fireEvent.pointerDown(action);
    fireEvent.click(action);

    expect(onReplyQuote).toHaveBeenCalledWith({
      source_message_id: "2",
      excerpt: "答案",
      source_anchor: { version: 1, start: 0, end: 2 },
    });
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it("keeps 询问Piko hidden while the pointer selection is still active", async () => {
    vi.useFakeTimers();
    render(<MessageThread messages={messages} conversationId="10" onReplyQuote={vi.fn()} />);
    const answer = screen.getByText("答案");
    const range = document.createRange();
    range.selectNodeContents(answer);
    Object.defineProperty(range, "getClientRects", {
      value: () => [{ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }),
    });

    fireEvent.pointerDown(answer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();

    fireEvent.pointerUp(answer);
    await act(() => vi.advanceTimersByTimeAsync(99));
    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("button", { name: "询问Piko" })).toBeInTheDocument();
  });

  it("does not restore a pending selection action after the thread scrolls", async () => {
    vi.useFakeTimers();
    render(<MessageThread messages={messages} conversationId="10" onReplyQuote={vi.fn()} />);
    const answer = screen.getByText("答案");
    const range = document.createRange();
    range.selectNodeContents(answer);
    Object.defineProperty(range, "getClientRects", {
      value: () => [{ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await act(() => vi.advanceTimersByTimeAsync(50));

    fireEvent.scroll(document);
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();
  });

  it("keeps the selection action dismissed after an outside pointer interaction", async () => {
    vi.useFakeTimers();
    render(<MessageThread messages={messages} conversationId="10" onReplyQuote={vi.fn()} />);
    const answer = screen.getByText("答案");
    const range = document.createRange();
    range.selectNodeContents(answer);
    Object.defineProperty(range, "getClientRects", {
      value: () => [{ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({ top: 100, right: 180, bottom: 122, left: 100, width: 80, height: 22 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByRole("button", { name: "询问Piko" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.keyUp(document, { key: "Tab" });
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();
  });

  it("does not offer a reply quote action for a cross-message selection", () => {
    render(
      <MessageThread messages={messages} conversationId="10" onReplyQuote={vi.fn()} />,
    );
    const question = screen.getByText("问题").firstChild as Text;
    const answer = screen.getByText("答案").firstChild as Text;
    const range = document.createRange();
    range.setStart(question, 0);
    range.setEnd(answer, answer.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    expect(screen.queryByRole("button", { name: "询问Piko" })).toBeNull();
  });

  it("renders a pending user message without message actions", () => {
    render(<MessageThread messages={[]} pendingMessage={pendingMessage} />);
    expect(screen.getByText("刚刚发送的问题")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /复制|编辑并重发/ })).toBeNull();
  });

  it("reserves action-bar height under the pending bubble on desktop only", () => {
    const { container, rerender } = render(
      <MessageThread messages={[]} pendingMessage={pendingMessage} />,
    );
    expect(
      container.querySelector('[data-state="pending"] .msg-actions'),
    ).not.toBeNull();

    rerender(<MessageThread messages={[]} pendingMessage={pendingMessage} isMobile />);
    expect(
      container.querySelector('[data-state="pending"] .msg-actions'),
    ).toBeNull();
  });

  it("renders a pure-image pending message and preserves its image node on commit", () => {
    const attachment = {
      id: "file-1",
      name: "photo.png",
      media_type: "image/png",
      size_bytes: 7,
      category: "image" as const,
      model_input_kind: "image" as const,
      warning: [],
      preview_available: true,
      stats: { width: 640, height: 480 },
    };
    const optimistic: MessageResponse = {
      ...pendingMessage,
      content: "",
      attachments: [attachment],
    };
    const committed: MessageResponse = {
      ...optimistic,
      id: "server-message-1",
      run_id: "100",
    };
    const previews = new Map([[attachment.id, "blob:composer-preview"]]);
    const { container, rerender } = render(
      <MessageThread
        messages={[]}
        pendingMessage={optimistic}
        pendingMessageKey="client-submission-1"
        localImagePreviews={previews}
      />,
    );

    const pendingImage = screen.getByRole("img", { name: "photo.png" });
    expect(container.querySelector('[data-state="pending"]')).not.toBeNull();
    expect(pendingImage).toHaveAttribute("src", "blob:composer-preview");

    rerender(
      <MessageThread
        messages={[committed]}
        messageRenderKeys={new Map([[committed.id, "client-submission-1"]])}
        localImagePreviews={previews}
      />,
    );

    expect(screen.getByRole("img", { name: "photo.png" })).toBe(pendingImage);
    expect(container.querySelector('[data-state="pending"]')).toBeNull();
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
