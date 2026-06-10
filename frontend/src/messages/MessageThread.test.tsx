import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MessageResponse } from "../api/types";
import { MessageThread } from "./MessageThread";

const messages: MessageResponse[] = [
  {
    id: 1, conversation_id: 10, run_id: null, role: "user",
    content: "问题", reasoning: null, position: 1, created_at: "2026-06-08T10:00:00Z",
  },
  {
    id: 2, conversation_id: 10, run_id: 100, role: "assistant",
    content: "答案", reasoning: null, position: 2, created_at: "2026-06-08T10:00:01Z",
  },
];

describe("MessageThread", () => {
  it("renders all messages", () => {
    render(<MessageThread messages={messages} />);
    expect(screen.getByText("问题")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });

  it("passes isMobile down so messages render the more button", () => {
    render(<MessageThread messages={messages} isMobile />);
    // One "更多" button per message on mobile.
    expect(screen.getAllByRole("button", { name: /更多/ })).toHaveLength(messages.length);
  });
});
