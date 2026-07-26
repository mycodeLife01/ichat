import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { Composer } from "./Composer";

const noop = () => {};

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    value: "",
    onChange: noop,
    onSend: noop,
    onStop: noop,
    state: "idle",
    thinkingLevel: "fast",
    onThinkingLevelChange: noop,
    ...overrides,
  };
  return render(<Composer {...props} />);
}

describe("Composer", () => {
  it("disables send when empty (idle)", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("enables send with non-empty input (idle)", () => {
    renderComposer({ value: "hi" });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("calls onSend on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onSend });
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalled();
  });

  it("does not send on Shift+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onSend });
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send on Enter while an IME composition is active", () => {
    const onSend = vi.fn();
    renderComposer({ value: "nihao", onSend });
    fireEvent.keyDown(screen.getByPlaceholderText("有问题，尽管问"), {
      key: "Enter",
      isComposing: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clicking send calls onSend", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onSend });
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("shows the stop button while streaming and calls onStop", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    renderComposer({ value: "hi", onStop, state: "streaming" });
    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toBeEnabled();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    await user.click(stop);
    expect(onStop).toHaveBeenCalled();
  });

  it("disables the stop button and marks it busy while stopping", () => {
    renderComposer({ value: "hi", state: "stopping" });
    const stopping = screen.getByRole("button", { name: "停止中" });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveAttribute("aria-busy", "true");
  });

  it("shows the current thinking level on the trigger button", () => {
    renderComposer({ thinkingLevel: "max" });
    expect(screen.getByRole("button", { name: "智能水平" })).toHaveTextContent("极致");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the level menu with Chinese labels and checks the current one", async () => {
    const user = userEvent.setup();
    renderComposer({ thinkingLevel: "high" });

    const trigger = screen.getByRole("button", { name: "智能水平" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByRole("menu", { name: "智能水平" })).toBeInTheDocument();
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((o) => o.textContent)).toEqual(["快速", "高", "极致"]);
    expect(screen.getByRole("menuitemradio", { name: "高" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "快速" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("selecting a level notifies and closes the menu", async () => {
    const onThinkingLevelChange = vi.fn();
    const user = userEvent.setup();
    renderComposer({ thinkingLevel: "fast", onThinkingLevelChange });

    await user.click(screen.getByRole("button", { name: "智能水平" }));
    await user.click(screen.getByRole("menuitemradio", { name: "极致" }));

    expect(onThinkingLevelChange).toHaveBeenCalledWith("max");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not show a voice input button", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "语音输入" })).toBeNull();
  });

  it("toggles the web search tool and disables it when unavailable", async () => {
    const onWebSearchEnabledChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderComposer({ onWebSearchEnabledChange });

    const searchButton = screen.getByRole("button", { name: "智能搜索" });
    expect(searchButton).toHaveAttribute("aria-pressed", "false");
    await user.click(searchButton);
    expect(onWebSearchEnabledChange).toHaveBeenCalledWith(true);

    rerender(
      <Composer
        value=""
        onChange={noop}
        onSend={noop}
        onStop={noop}
        state="idle"
        thinkingLevel="fast"
        onThinkingLevelChange={noop}
        webSearchEnabled
        webSearchAvailable={false}
        onWebSearchEnabledChange={onWebSearchEnabledChange}
      />,
    );
    expect(screen.getByRole("button", { name: "智能搜索" })).toBeDisabled();
  });

  it("exposes the web search toggle as pressed while enabled", () => {
    renderComposer({ webSearchEnabled: true });
    expect(screen.getByRole("button", { name: "智能搜索" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("closes the level menu when clicking outside", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "智能水平" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByPlaceholderText("有问题，尽管问"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
