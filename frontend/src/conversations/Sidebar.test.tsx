import { fireEvent, render, screen } from "@testing-library/react";
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
    user: { email: "a@b.com", name: "alice" },
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
    onToggleCollapsed: vi.fn(),
    onCloseMobile: vi.fn(),
  };
}

describe("Sidebar", () => {
  it("groups conversations and renders rows", () => {
    render(<Sidebar {...baseProps()} />);
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText("今天的对话")).toBeInTheDocument();
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

  it("logs out", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(props.onLogout).toHaveBeenCalled();
  });
});
