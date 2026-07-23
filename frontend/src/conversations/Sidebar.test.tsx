import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConversationResponse } from "../api/types";
import { Sidebar } from "./Sidebar";

function makeConversation(
  id: string,
  title: string,
  updatedAt: string,
): ConversationResponse {
  return {
    id,
    title,
    activated_at: updatedAt,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

const today = new Date().toISOString();

function baseProps() {
  return {
    items: [makeConversation("1", "今天的对话", today)],
    selectedId: "1",
    user: {
      email: "a@b.com",
      username: "alice-login",
      name: "alice",
      emailVerified: true,
    },
    isMobile: false,
    collapsed: false,
    mobileOpen: false,
    pendingTitleIds: [] as string[],
    hasMore: false,
    isLoadingMore: false,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onLoadMore: vi.fn(),
    onRename: vi.fn(),
    onRequestShare: vi.fn(),
    onRequestDelete: vi.fn(),
    onLogout: vi.fn(),
    onResendVerification: vi.fn(async () => ({ status: "ok" })),
    onUpdateNickname: vi.fn(async () => ({ status: "ok" })),
    onChangePassword: vi.fn(async () => ({ status: "ok" })),
    onRequestDeletion: vi.fn(async () => ({ status: "ok" })),
    onLoadShares: vi.fn(async () => []),
    onRevokeShare: vi.fn(async () => ({ status: "ok" })),
    onToast: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onCloseMobile: vi.fn(),
  };
}

describe("Sidebar", () => {
  it("renders one chat section and emphasizes every conversation title", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const older = new Date(Date.now() - 172_800_000).toISOString();

    render(
      <Sidebar
        {...baseProps()}
        items={[
          makeConversation("1", "今天的对话", today),
          makeConversation("2", "昨天的对话", yesterday),
          makeConversation("3", "更早的对话", older),
        ]}
      />,
    );

    expect(screen.getByText("聊天")).toBeInTheDocument();
    expect(screen.queryByText("今天")).toBeNull();
    expect(screen.queryByText("昨天")).toBeNull();
    expect(screen.queryByText("更早")).toBeNull();

    for (const title of ["今天的对话", "昨天的对话", "更早的对话"]) {
      expect(screen.getByText(title).closest(".history-row")).toHaveClass(
        "font-medium",
        "text-fg",
      );
    }
  });

  it("renders a title skeleton for a title-pending row", () => {
    const props = baseProps();
    // A conversation whose auto-title hasn't been written back yet (title empty)
    // and is in pendingTitleIds shows the skeleton, not a 新对话 fallback.
    const { container } = render(
      <Sidebar
        {...props}
        items={[makeConversation("1", "", today)]}
        pendingTitleIds={["1"]}
      />,
    );
    expect(container.querySelector(".title-skeleton")).toBeTruthy();
    expect(screen.queryByText("新对话")).toBeNull();
  });

  it("shows empty placeholder when no conversations", () => {
    render(<Sidebar {...baseProps()} items={[]} />);
    expect(
      screen.getByText(/还没有已保存的对话/),
    ).toBeInTheDocument();
  });

  it("renames in place on Enter", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByDisplayValue("今天的对话");
    await user.clear(input);
    await user.type(input, "新名字{Enter}");

    expect(props.onRename).toHaveBeenCalledWith("1", "新名字");
  });

  it("requests delete via the row menu", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("button", { name: "删除对话" }));

    expect(props.onRequestDelete).toHaveBeenCalledWith("1");
  });

  it("mobile: opens a bottom sheet with rename / delete", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} isMobile />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    // The actions live in a bottom sheet on mobile, not the desktop dropdown.
    // The sheet is portaled to <body>, so query the document, not the container.
    expect(document.querySelector(".sheet")).not.toBeNull();
    expect(document.querySelector(".history-menu")).toBeNull();

    await user.click(screen.getByRole("button", { name: "删除对话" }));
    expect(props.onRequestDelete).toHaveBeenCalledWith("1");
  });

  it("mobile: rename from the sheet enters in-place editing", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} isMobile />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByDisplayValue("今天的对话");
    await user.clear(input);
    await user.type(input, "改名{Enter}");

    expect(props.onRename).toHaveBeenCalledWith("1", "改名");
  });

  it("requests another page when scrolled near the bottom", () => {
    const props = { ...baseProps(), hasMore: true };
    render(<Sidebar {...props} />);
    const history = screen.getByTestId("conversation-history");
    Object.defineProperty(history, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(history, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(history, "scrollTop", { value: 560, configurable: true });

    fireEvent.scroll(history);

    expect(props.onLoadMore).toHaveBeenCalled();
  });

  it("keeps username out of the user menu", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    const trigger = screen.getByRole("button", { name: "打开个人中心" });
    expect(within(trigger).getByText("alice")).toBeInTheDocument();
    expect(within(trigger).getByText("Pro")).toBeInTheDocument();
    expect(within(trigger).queryByText("alice-login")).toBeNull();

    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: "个人中心" });
    expect(within(menu).getByText("alice")).toBeInTheDocument();
    expect(within(menu).getByText("a@b.com")).toBeInTheDocument();
    expect(within(menu).queryByText("用户名")).toBeNull();
    expect(within(menu).queryByText("alice-login")).toBeNull();
    expect(
      within(menu).queryByRole("button", { name: /alice.*a@b\.com/i }),
    ).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "账号" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "我的分享" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "退出登录" })).toBeInTheDocument();
  });

  it("closes the user menu when pressing outside it", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));
    expect(screen.getByRole("menu", { name: "个人中心" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menu", { name: "个人中心" })).toBeNull();
  });

  it("opens the account and my-shares cards from their menu items", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));
    await user.click(screen.getByRole("menuitem", { name: "账号" }));
    expect(screen.getByRole("dialog", { name: "账号" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭账号" }));

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));
    await user.click(screen.getByRole("menuitem", { name: "我的分享" }));
    expect(screen.getByRole("dialog", { name: "我的分享" })).toBeInTheDocument();
    expect(await screen.findByText("还没有有效的会话分享")).toBeInTheDocument();
  });

  it("closes the user menu when pressing Escape", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));
    expect(screen.getByRole("menu", { name: "个人中心" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "个人中心" })).toBeNull();
  });

  it("opens logout confirmation and cancels without logging out", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));

    const dialog = screen.getByRole("dialog", { name: "你确定要退出登录吗？" });
    expect(within(dialog).getByText("alice")).toBeInTheDocument();
    expect(within(dialog).getByText("a@b.com")).toBeInTheDocument();
    expect(props.onLogout).not.toHaveBeenCalled();

    const cancelButton = within(dialog).getByRole("button", { name: "取消" });
    expect(cancelButton).toHaveFocus();
    await user.click(cancelButton);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "打开个人中心" })).toHaveFocus();
    expect(props.onLogout).not.toHaveBeenCalled();
  });

  it("closes the logout confirmation when pressing Escape", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(screen.getByRole("dialog", { name: "你确定要退出登录吗？" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "打开个人中心" })).toHaveFocus();
  });
});
