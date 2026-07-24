import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders title and body", () => {
    render(
      <ConfirmDialog
        title="删除对话？"
        body="无法恢复。"
        confirmLabel="删除"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("删除对话？")).toBeInTheDocument();
    expect(screen.getByText("无法恢复。")).toBeInTheDocument();
  });

  it("invokes confirm and cancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        title="t"
        body="b"
        confirmLabel="删除"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("exposes a destructive confirmation as a labelled alert dialog", () => {
    render(
      <ConfirmDialog
        title="删除对话？"
        body="无法恢复。"
        confirmLabel="删除"
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByRole("alertdialog", { name: "删除对话？" });
    expect(dialog).toHaveAccessibleDescription("无法恢复。");
  });

  it("moves focus to cancel, closes with Escape, and restores the trigger", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开确认框
          </button>
          {open && (
            <ConfirmDialog
              title="删除对话？"
              body="无法恢复。"
              confirmLabel="删除"
              destructive
              onConfirm={onConfirm}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开确认框" });
    await user.click(trigger);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });
});
