import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

const noop = () => {};

describe("Composer", () => {
  it("disables send when empty (idle)", () => {
    render(<Composer value="" onChange={noop} onSend={noop} onStop={noop} state="idle" />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("enables send with non-empty input (idle)", () => {
    render(<Composer value="hi" onChange={noop} onSend={noop} onStop={noop} state="idle" />);
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("calls onSend on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={onSend} onStop={noop} state="idle" />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalled();
  });

  it("does not send on Shift+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={onSend} onStop={noop} state="idle" />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clicking send calls onSend", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={onSend} onStop={noop} state="idle" />);
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("shows the stop button while streaming and calls onStop", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={noop} onStop={onStop} state="streaming" />);
    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toBeEnabled();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    await user.click(stop);
    expect(onStop).toHaveBeenCalled();
  });

  it("disables the stop button while stopping", () => {
    render(<Composer value="hi" onChange={noop} onSend={noop} onStop={noop} state="stopping" />);
    expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();
  });
});
