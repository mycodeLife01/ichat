import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Icons } from "../ui/icons";
import { MessageAction } from "./MessageAction";

describe("MessageAction", () => {
  it("shows only the icon by default — no label text", () => {
    render(<MessageAction label="复制" icon={<Icons.Copy size={15} />} onClick={() => {}} />);
    // The label is the accessible name (aria-label) but not visible text.
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(screen.queryByText("复制")).toBeNull();
  });

  it("reveals the label in a dropdown below on hover", async () => {
    const user = userEvent.setup();
    render(<MessageAction label="重新生成" icon={<Icons.Refresh size={15} />} onClick={() => {}} />);

    await user.hover(screen.getByRole("button", { name: "重新生成" }));
    expect(screen.getByText("重新生成")).toBeInTheDocument();

    await user.unhover(screen.getByRole("button", { name: "重新生成" }));
    expect(screen.queryByText("重新生成")).toBeNull();
  });

  it("runs the action and hides the dropdown on click", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<MessageAction label="复制" icon={<Icons.Copy size={15} />} onClick={onClick} />);

    const button = screen.getByRole("button", { name: "复制" });
    await user.hover(button);
    expect(screen.getByText("复制")).toBeInTheDocument();

    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Dropdown disappears after the click even though the cursor is still over it.
    expect(screen.queryByText("复制")).toBeNull();
  });

  it("disables the button and shows the reason on hover", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageAction
        label="重新生成"
        icon={<Icons.Refresh size={15} />}
        onClick={onClick}
        disabled
        disabledReason="请先停止当前生成"
      />,
    );

    const button = screen.getByRole("button", { name: "重新生成" });
    expect(button).toBeDisabled();
    await user.hover(button);
    expect(screen.getByText("请先停止当前生成")).toBeInTheDocument();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
