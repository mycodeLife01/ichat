import { render, screen } from "@testing-library/react";
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

  it("disables the stop button while stopping", () => {
    renderComposer({ value: "hi", state: "stopping" });
    expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();
  });

  it("shows the current thinking level on the trigger button", () => {
    renderComposer({ thinkingLevel: "max" });
    expect(screen.getByRole("button", { name: "智能水平" })).toHaveTextContent("Max");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the level menu with Fast/High/Max and checks the current one", async () => {
    const user = userEvent.setup();
    renderComposer({ thinkingLevel: "high" });

    await user.click(screen.getByRole("button", { name: "智能水平" }));

    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((o) => o.textContent)).toEqual(["Fast", "High", "Max"]);
    expect(screen.getByRole("menuitemradio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Fast" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("selecting a level notifies and closes the menu", async () => {
    const onThinkingLevelChange = vi.fn();
    const user = userEvent.setup();
    renderComposer({ thinkingLevel: "fast", onThinkingLevelChange });

    await user.click(screen.getByRole("button", { name: "智能水平" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Max" }));

    expect(onThinkingLevelChange).toHaveBeenCalledWith("max");
    expect(screen.queryByRole("menu")).toBeNull();
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
