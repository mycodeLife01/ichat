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

  it("edits a user message and submits the new content", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("你好");
    await user.clear(textarea);
    await user.type(textarea, "改写后的问题");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onEditAndRegenerate).toHaveBeenCalledWith(userMessage.id, "改写后的问题");
  });

  it("cancels editing without calling back", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(onEditAndRegenerate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("does not submit an empty edit", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    await user.clear(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onEditAndRegenerate).not.toHaveBeenCalled();
  });

  it("regenerates an assistant message", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(
      <Message
        message={assistantMessage}
        mutateDisabledReason={null}
        onRegenerate={onRegenerate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledWith(assistantMessage.id);
  });

  it("disables mutate buttons with a reason while a run is active", () => {
    const reason = "请先停止当前生成";
    const { rerender } = render(
      <Message message={userMessage} mutateDisabledReason={reason} />,
    );
    const editBtn = screen.getByRole("button", { name: /编辑并重发/ });
    expect(editBtn).toBeDisabled();
    expect(editBtn).toHaveAttribute("title", reason);
    // Copy stays enabled.
    expect(screen.getByRole("button", { name: /复制/ })).toBeEnabled();

    rerender(<Message message={assistantMessage} mutateDisabledReason={reason} />);
    const regenBtn = screen.getByRole("button", { name: /重新生成/ });
    expect(regenBtn).toBeDisabled();
    expect(regenBtn).toHaveAttribute("title", reason);
  });

  it("desktop: does not render a more button", () => {
    render(<Message message={userMessage} />);
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();
  });

  it("mobile: hides actions behind a more button that opens a sheet (user)", async () => {
    const user = userEvent.setup();
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        isMobile
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    // Actions live behind the sheet; only the more button shows directly.
    expect(screen.queryByRole("button", { name: /复制/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    // The mobile edit action enters the same inline editor.
    expect(screen.getByRole("textbox")).toHaveValue("你好");
  });

  it("mobile: copies from the sheet", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<Message message={userMessage} isMobile />);

    await user.click(screen.getByRole("button", { name: /更多/ }));
    await user.click(screen.getByRole("button", { name: /复制/ }));
    expect(writeText).toHaveBeenCalledWith("你好");
  });

  it("mobile: regenerates an assistant message from the sheet", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(<Message message={assistantMessage} isMobile onRegenerate={onRegenerate} />);

    await user.click(screen.getByRole("button", { name: /更多/ }));
    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledWith(assistantMessage.id);
  });

  it("mobile: disables the mutate action in the sheet with a reason", async () => {
    const reason = "请先停止当前生成";
    const user = userEvent.setup();
    render(<Message message={userMessage} isMobile mutateDisabledReason={reason} />);

    await user.click(screen.getByRole("button", { name: /更多/ }));
    const editBtn = screen.getByRole("button", { name: /编辑并重发/ });
    expect(editBtn).toBeDisabled();
    expect(editBtn).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: /复制/ })).toBeEnabled();
  });
});
