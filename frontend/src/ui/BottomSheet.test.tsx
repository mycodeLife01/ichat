import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BottomSheet } from "./BottomSheet";

describe("BottomSheet", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <BottomSheet open={false} onClose={() => {}} ariaLabel="消息操作">
        <button>复制</button>
      </BottomSheet>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the panel and children when open", () => {
    render(
      <BottomSheet open onClose={() => {}} ariaLabel="消息操作">
        <button>复制</button>
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "消息操作" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(document.querySelector(".sheet")).not.toBeNull();
    expect(document.querySelector(".sheet-handle")).not.toBeNull();
  });

  it("keeps the backdrop color stable while the sheet enters", () => {
    render(
      <BottomSheet open onClose={() => {}} ariaLabel="消息操作">
        <button>复制</button>
      </BottomSheet>,
    );

    const backdrop = document.querySelector(".sheet-backdrop");
    const scrim = document.querySelector(".sheet-scrim");
    const sheet = document.querySelector(".sheet");
    expect(scrim).toHaveClass("bg-overlay");
    expect(scrim?.parentElement).toBe(backdrop);
    expect(sheet?.parentElement).toBe(backdrop);
    expect(scrim).not.toBe(sheet);
    expect(scrim?.className).not.toMatch(
      /transition-(?:colors|opacity)|animate-/,
    );
  });

  it("can keep a click-blocking backdrop transparent over an existing scrim", () => {
    render(
      <BottomSheet
        open
        onClose={() => {}}
        ariaLabel="消息操作"
        dimBackground={false}
      >
        <button>复制</button>
      </BottomSheet>,
    );

    expect(document.querySelector(".sheet-scrim")).toHaveClass("bg-transparent");
    expect(document.querySelector(".sheet-scrim")).not.toHaveClass("bg-overlay");
  });

  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BottomSheet open onClose={onClose} ariaLabel="消息操作">
        <button>复制</button>
      </BottomSheet>,
    );
    await user.click(document.querySelector(".sheet-scrim")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the panel content is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BottomSheet open onClose={onClose} ariaLabel="消息操作">
        <button>复制</button>
      </BottomSheet>,
    );
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("portals out of a transformed ancestor so fixed positioning uses the viewport", () => {
    // A transformed ancestor (e.g. the open mobile sidebar) becomes the
    // containing block for position:fixed, which would clamp the sheet to the
    // ancestor's width. Portaling to <body> escapes that.
    const { container } = render(
      <div style={{ transform: "translateX(0)" }}>
        <BottomSheet open onClose={() => {}} ariaLabel="消息操作">
          <button>复制</button>
        </BottomSheet>
      </div>,
    );
    expect(container.querySelector(".sheet-backdrop")).toBeNull();
    expect(document.querySelector(".sheet-backdrop")).not.toBeNull();
  });

  it("closes when Escape is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BottomSheet open onClose={onClose} ariaLabel="消息操作">
        <button>复制</button>
      </BottomSheet>,
    );

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the sheet without preselecting an action and traps Tab navigation", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <button>背景操作</button>
        <BottomSheet open onClose={() => {}} ariaLabel="消息操作">
          <button>复制</button>
          <button>编辑</button>
        </BottomSheet>
      </>,
    );

    expect(screen.getByRole("dialog", { name: "消息操作" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "复制" })).not.toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "复制" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "编辑" })).toHaveFocus();

    rerender(
      <>
        <button>背景操作</button>
        <BottomSheet open onClose={() => {}} ariaLabel="消息操作">
          <button>复制</button>
          <button>编辑</button>
        </BottomSheet>
      </>,
    );
    expect(screen.getByRole("button", { name: "编辑" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "复制" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "编辑" })).toHaveFocus();
  });
});
