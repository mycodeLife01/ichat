import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("renders one chat section and exposes the selected conversation", () => {
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

    expect(screen.getByRole("button", { name: "今天的对话" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "昨天的对话" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("distinguishes the chat section label from compact history rows", () => {
    render(<Sidebar {...baseProps()} />);

    expect(screen.getByText("聊天")).toHaveClass(
      "text-[14px]",
      "font-semibold",
      "leading-5",
    );
    expect(screen.getByText("今天的对话").closest(".history-row")).toHaveClass(
      "text-[14px]",
      "font-normal",
      "leading-5",
    );
    expect(screen.getByTestId("conversation-history")).not.toHaveClass("gap-px");
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

  it("collapsed: keeps a rail with new chat, recent chats and the account avatar", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    const items = Array.from({ length: 12 }, (_, index) =>
      makeConversation(`${index + 1}`, `对话${index + 1}`, today),
    );
    render(<Sidebar {...props} collapsed items={items} />);

    // The fixed-width panel stays mounted so the outer edge can crop it without
    // moving its contents; inert/aria-hidden remove it from interaction.
    const history = screen.getByTestId("conversation-history");
    expect(history.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(history.parentElement).toHaveAttribute("inert");

    await user.click(screen.getByRole("button", { name: "新建对话" }));
    expect(props.onNew).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "打开个人中心" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "最近聊天" }));
    const panel = screen.getByRole("navigation", { name: "最近聊天" });
    expect(panel.parentElement).toBe(document.body);
    expect(within(panel).getByRole("button", { name: "对话1" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "对话10" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "对话11" })).toBeNull();
  });

  it("desktop: keeps the same account trigger mounted while the right edge collapses", () => {
    const props = baseProps();
    const { rerender } = render(<Sidebar {...props} />);
    const accountTrigger = screen.getByRole("button", { name: "打开个人中心" });

    rerender(<Sidebar {...props} collapsed />);

    expect(screen.getByRole("button", { name: "打开个人中心" })).toBe(accountTrigger);
    expect(accountTrigger).toHaveClass("h-13", "px-2");
    expect(document.querySelector('[data-icon="recent-chats"]')).toBeInTheDocument();
  });

  it("collapsed: recent rows keep share / rename / delete and close on select", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} collapsed />);

    await user.click(screen.getByRole("button", { name: "最近聊天" }));
    const panel = screen.getByRole("navigation", { name: "最近聊天" });

    await user.click(within(panel).getByRole("button", { name: "更多" }));
    const menu = screen.getByRole("menu", { name: "会话操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "分享",
      "重命名",
      "删除",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "分享" }));
    expect(props.onRequestShare).toHaveBeenCalledWith("1");

    await user.click(within(panel).getByRole("button", { name: "今天的对话" }));
    expect(props.onSelect).toHaveBeenCalledWith("1");
    expect(screen.queryByRole("navigation", { name: "最近聊天" })).toBeNull();
  });

  it("renames in place on Enter", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByDisplayValue("今天的对话");
    await user.clear(input);
    await user.type(input, "新名字{Enter}");

    expect(props.onRename).toHaveBeenCalledWith("1", "新名字");
  });

  it("requests delete via the row menu", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    const row = screen.getByText("今天的对话").closest(".history-row");
    expect(row).not.toBeNull();
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 52,
        height: 32,
        left: 10,
        right: 270,
        top: 20,
        width: 260,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
    });

    await user.click(screen.getByRole("button", { name: "更多" }));

    const menu = screen.getByRole("menu", { name: "会话操作" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ left: "226px", top: "48px" });

    const actions = within(menu).getAllByRole("menuitem");
    expect(actions.map((action) => action.textContent)).toEqual(["分享", "重命名", "删除"]);
    expect(actions[0]).toHaveAttribute("data-variant", "neutral");
    expect(actions[2]).toHaveAttribute("data-variant", "danger");

    await user.click(within(menu).getByRole("menuitem", { name: "删除" }));

    expect(props.onRequestDelete).toHaveBeenCalledWith("1");
  });

  it("closes the desktop conversation menu on Escape and outside click", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    const trigger = screen.getByRole("button", { name: "更多" });
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "会话操作" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "会话操作" })).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "会话操作" })).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("menu", { name: "会话操作" })).toBeNull();
  });

  it("mobile: opens a bottom sheet with rename / delete", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} isMobile mobileOpen />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    // The actions live in a bottom sheet on mobile, not the desktop dropdown.
    // The sheet is portaled to <body>, so query the document, not the container.
    const sheet = screen.getByRole("dialog", { name: "会话操作" });
    expect(sheet).toBeInTheDocument();
    expect(document.querySelector(".history-menu")).toBeNull();
    expect(document.querySelector(".sheet-scrim")).toHaveClass("bg-transparent");
    const actions = within(sheet).getAllByRole("button");
    expect(actions.map((action) => action.textContent)).toEqual(["分享", "重命名", "删除"]);
    expect(actions[2]).toHaveAttribute("data-variant", "danger");

    await user.click(within(sheet).getByRole("button", { name: "删除" }));
    expect(props.onRequestDelete).toHaveBeenCalledWith("1");
  });

  it("mobile: rename from the sheet enters in-place editing", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} isMobile mobileOpen />);

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

  it("desktop: automatically fills another page when history does not overflow", async () => {
    const props = { ...baseProps(), hasMore: true };
    render(<Sidebar {...props} />);
    const history = screen.getByTestId("conversation-history");
    Object.defineProperty(history, "scrollHeight", { value: 400, configurable: true });
    Object.defineProperty(history, "clientHeight", { value: 400, configurable: true });

    window.dispatchEvent(new Event("resize"));

    await waitFor(() => expect(props.onLoadMore).toHaveBeenCalledTimes(1));
  });

  it("mobile: keeps the drawer scrim color stable while opening", () => {
    render(<Sidebar {...baseProps()} isMobile mobileOpen />);

    expect(document.querySelector(".scrim")?.className).not.toMatch(
      /transition-(?:colors|opacity)|animate-/,
    );
  });

  it("keeps username out of the user menu", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} />);

    const trigger = screen.getByRole("button", { name: "打开个人中心" });
    expect(within(trigger).getByText("alice")).toBeInTheDocument();
    expect(within(trigger).getByText("Pro")).toBeInTheDocument();
    expect(within(trigger).queryByText("alice-login")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: "个人中心" });
    expect(menu.parentElement).toBe(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getByText("alice")).toBeInTheDocument();
    expect(within(menu).getByText("a@b.com")).toBeInTheDocument();
    expect(within(menu).queryByText("用户名")).toBeNull();
    expect(within(menu).queryByText("alice-login")).toBeNull();
    expect(
      within(menu).queryByRole("button", { name: /alice.*a@b\.com/i }),
    ).toBeNull();
    const accountItem = within(menu).getByRole("menuitem", { name: "账号" });
    const sharesItem = within(menu).getByRole("menuitem", { name: "我的分享" });
    const logoutItem = within(menu).getByRole("menuitem", { name: "退出登录" });
    expect(accountItem).toHaveAttribute("data-variant", "neutral");
    expect(sharesItem).toHaveAttribute("data-variant", "neutral");
    expect(logoutItem).toHaveAttribute("data-variant", "danger");
  });

  it("mobile: opens the personal actions in a bottom sheet", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...baseProps()} isMobile mobileOpen />);

    await user.click(screen.getByRole("button", { name: "打开个人中心" }));

    const sheet = screen.getByRole("dialog", { name: "个人中心" });
    expect(document.querySelector(".sheet-scrim")).toHaveClass("bg-transparent");
    expect(within(sheet).getByRole("button", { name: "账号" })).toHaveAttribute(
      "data-variant",
      "neutral",
    );
    expect(within(sheet).getByRole("button", { name: "我的分享" })).toBeEnabled();
    expect(within(sheet).getByRole("button", { name: "退出登录" })).toHaveAttribute(
      "data-variant",
      "danger",
    );

    await user.click(within(sheet).getByRole("button", { name: "账号" }));
    expect(screen.getByRole("dialog", { name: "账号" })).toBeInTheDocument();
  });

  it("mobile: removes the closed drawer controls from the accessibility tree", () => {
    render(<Sidebar {...baseProps()} isMobile mobileOpen={false} />);

    expect(screen.queryByRole("button", { name: "今天的对话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开个人中心" })).toBeNull();
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute(
      "aria-hidden",
      "true",
    );
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
