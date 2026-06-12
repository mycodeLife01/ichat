import { act, fireEvent, render, screen } from "@testing-library/react";
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

// Simulates a touch held past the 450ms long-press window.
function longPress(el: HTMLElement) {
  vi.useFakeTimers();
  fireEvent.touchStart(el);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  vi.useRealTimers();
}

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

  it("renders assistant source chips from metadata", () => {
    render(
      <Message
        message={{
          ...assistantMessage,
          metadata: {
            sources: [
              {
                id: 1,
                title: "Release notes",
                url: "https://www.example.com/releases",
                snippet: "Version 1.2 shipped.",
                published_at: "2026-06-11",
                provider: "tavily",
              },
            ],
          },
        }}
      />,
    );

    const link = screen.getByRole("link", { name: /\[1\] Release notes example\.com/ });
    expect(link).toHaveAttribute("href", "https://www.example.com/releases");
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

  it("disables the mutate button and shows the reason on hover", async () => {
    const reason = "请先停止当前生成";
    const user = userEvent.setup();
    const { rerender } = render(
      <Message message={userMessage} mutateDisabledReason={reason} />,
    );
    const editBtn = screen.getByRole("button", { name: "编辑并重发" });
    expect(editBtn).toBeDisabled();
    await user.hover(editBtn);
    expect(screen.getByText(reason)).toBeInTheDocument();
    // Copy stays enabled.
    expect(screen.getByRole("button", { name: /复制/ })).toBeEnabled();

    rerender(<Message message={assistantMessage} mutateDisabledReason={reason} />);
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });

  it("desktop: hides labels until hover, then shows a dropdown", async () => {
    const user = userEvent.setup();
    render(<Message message={assistantMessage} mutateDisabledReason={null} />);
    // Icon-only by default: the label is the accessible name, not visible text.
    expect(screen.queryByText("重新生成")).toBeNull();
    await user.hover(screen.getByRole("button", { name: "重新生成" }));
    expect(screen.getByText("重新生成")).toBeInTheDocument();
  });

  it("desktop: swaps the copy icon to a check after copying", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<Message message={assistantMessage} />);

    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("desktop: assistant bar is resident (always visible), user bar is not", () => {
    const { container, rerender } = render(<Message message={assistantMessage} />);
    expect(container.querySelector(".msg-actions")).toHaveClass("resident");
    rerender(<Message message={userMessage} />);
    expect(container.querySelector(".msg-actions")).not.toHaveClass("resident");
  });

  it("desktop: does not render a more button", () => {
    render(<Message message={userMessage} />);
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();
  });

  it("mobile: long-press on the user bubble opens the action sheet", async () => {
    const onEditAndRegenerate = vi.fn();
    render(
      <Message
        message={userMessage}
        isMobile
        mutateDisabledReason={null}
        onEditAndRegenerate={onEditAndRegenerate}
      />,
    );

    // No visible action button; actions live behind the long-press sheet.
    expect(screen.queryByRole("button", { name: /复制/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    longPress(screen.getByText("你好"));
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /编辑并重发/ }));
    // The mobile edit action enters the same inline editor.
    expect(screen.getByRole("textbox")).toHaveValue("你好");
  });

  it("mobile: a released touch does not open the sheet", () => {
    render(<Message message={userMessage} isMobile />);

    const bubble = screen.getByText("你好");
    vi.useFakeTimers();
    fireEvent.touchStart(bubble);
    fireEvent.touchEnd(bubble); // lifted before the long-press window
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();

    expect(screen.queryByRole("button", { name: /复制/ })).toBeNull();
  });

  it("mobile: copies from the sheet", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<Message message={userMessage} isMobile />);

    longPress(screen.getByText("你好"));
    await user.click(screen.getByRole("button", { name: /复制/ }));
    expect(writeText).toHaveBeenCalledWith("你好");
  });

  it("mobile: assistant actions are resident, no sheet involved", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(<Message message={assistantMessage} isMobile onRegenerate={onRegenerate} />);

    expect(screen.queryByRole("button", { name: /更多/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledWith(assistantMessage.id);
  });

  it("mobile: disables the mutate action in the sheet with a reason", async () => {
    const reason = "请先停止当前生成";
    render(<Message message={userMessage} isMobile mutateDisabledReason={reason} />);

    longPress(screen.getByText("你好"));
    const editBtn = screen.getByRole("button", { name: /编辑并重发/ });
    expect(editBtn).toBeDisabled();
    expect(editBtn).toHaveAttribute("title", reason);
    expect(screen.getByRole("button", { name: /复制/ })).toBeEnabled();
  });

  it("does not show an expand toggle for short user messages", () => {
    render(<Message message={userMessage} />);
    expect(screen.queryByRole("button", { name: /展开/ })).toBeNull();
  });

  it("collapses a tall user message and toggles 展开/收起", async () => {
    // jsdom has no layout: fake a content scrollHeight above the collapse cap.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 1000;
      },
    });

    try {
      const user = userEvent.setup();
      render(<Message message={userMessage} />);

      const expand = screen.getByRole("button", { name: /展开/ });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      // Collapsed content is height-clipped.
      const content = screen.getByText("你好");
      expect(content.style.maxHeight).not.toBe("");
      expect(content.style.overflow).toBe("hidden");

      await user.click(expand);
      const collapse = screen.getByRole("button", { name: /收起/ });
      expect(collapse).toHaveAttribute("aria-expanded", "true");
      expect(content.style.maxHeight).toBe("");

      await user.click(collapse);
      expect(screen.getByRole("button", { name: /展开/ })).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
      else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    }
  });
});
