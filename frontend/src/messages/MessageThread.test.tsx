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

describe("MessageThread", () => {
  it("renders all messages", () => {
    render(<MessageThread messages={messages} />);
    expect(screen.getByText("问题")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
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
