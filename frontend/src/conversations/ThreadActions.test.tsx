import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ThreadActions } from "./ThreadActions";

function baseProps() {
  return {
    isMobile: false,
    hasConversation: true,
    onOpenMobileSidebar: vi.fn(),
    onNew: vi.fn(),
    onShare: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe("ThreadActions", () => {
  it("desktop: shares directly and keeps delete in the more menu", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ThreadActions {...props} />);

    expect(screen.queryByRole("button", { name: "打开历史" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "分享" }));
    expect(props.onShare).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu", { name: "对话操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "删除",
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: "删除" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "对话操作" })).toBeNull();
  });

  it("mobile: keeps history and new chat, and moves share into the menu", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<ThreadActions {...props} isMobile />);

    await user.click(screen.getByRole("button", { name: "打开历史" }));
    expect(props.onOpenMobileSidebar).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "新建对话" }));
    expect(props.onNew).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "分享" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu", { name: "对话操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "分享",
      "删除",
    ]);

    await user.click(within(menu).getByRole("menuitem", { name: "分享" }));
    expect(props.onShare).toHaveBeenCalledTimes(1);
  });

  it("hides conversation-scoped actions on a blank new chat", () => {
    render(<ThreadActions {...baseProps()} hasConversation={false} isMobile />);

    expect(screen.getByRole("button", { name: "打开历史" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("closes the more menu on Escape", async () => {
    const user = userEvent.setup();
    render(<ThreadActions {...baseProps()} />);

    await user.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menu", { name: "对话操作" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "对话操作" })).toBeNull();
  });
});
