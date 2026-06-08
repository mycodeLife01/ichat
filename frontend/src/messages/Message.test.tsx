import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

const userMessage: MessageResponse = {
  id: 1,
  conversation_id: 10,
  run_id: null,
  role: "user",
  content: "你好",
  reasoning: null,
  position: 1,
  created_at: "2026-06-08T10:00:00Z",
};

const assistantMessage: MessageResponse = {
  id: 2,
  conversation_id: 10,
  run_id: 100,
  role: "assistant",
  content: "**回答**正文",
  reasoning: "我的推理",
  position: 2,
  created_at: "2026-06-08T10:00:01Z",
};

describe("Message", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders a user bubble", () => {
    render(<Message message={userMessage} />);
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("renders assistant markdown and thinking", () => {
    render(<Message message={assistantMessage} />);
    expect(screen.getByText("回答")).toBeInTheDocument(); // bold rendered
    expect(screen.getByText("已思考")).toBeInTheDocument();
  });

  it("copies content", async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs a (non-writable) clipboard stub; spy on its
    // writeText rather than replacing navigator.clipboard.
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    render(<Message message={userMessage} />);
    await user.click(screen.getByRole("button", { name: /复制/ }));

    expect(writeText).toHaveBeenCalledWith("你好");
  });

  it("disables edit/regenerate this step", () => {
    render(<Message message={assistantMessage} />);
    expect(screen.getByRole("button", { name: /重新生成/ })).toBeDisabled();
  });
});
