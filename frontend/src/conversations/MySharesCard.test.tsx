import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MySharesCard } from "./MySharesCard";

const share = {
  conversation_id: "conv-1",
  conversation_title: "项目讨论",
  token: "share-token",
  created_at: "2026-07-14T04:00:00Z",
  expires_at: null,
  revoked_at: null,
};

describe("MySharesCard", () => {
  it("stays open when a drag starts inside the card and ends on the backdrop", async () => {
    const onClose = vi.fn();
    render(
      <MySharesCard
        onClose={onClose}
        onLoad={async () => []}
        onRevoke={vi.fn()}
        onToast={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "我的分享" });
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();

    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(backdrop!);
    fireEvent.click(backdrop!);

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads shares, copies a link, and removes a revoked share", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onToast = vi.fn();
    const onRevoke = vi.fn(async () => ({ status: "ok" }));

    render(
      <MySharesCard
        onClose={vi.fn()}
        onLoad={async () => [share]}
        onRevoke={onRevoke}
        onToast={onToast}
      />,
    );

    const item = await screen.findByRole("article", { name: "项目讨论" });
    await user.click(within(item).getByRole("button", { name: "复制链接" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/share-token`);
    expect(onToast).toHaveBeenCalledWith("链接已复制", "success");

    await user.click(within(item).getByRole("button", { name: "撤销分享" }));
    expect(onRevoke).toHaveBeenCalledWith("conv-1", "share-token");
    expect(screen.queryByRole("article", { name: "项目讨论" })).toBeNull();
    expect(onToast).toHaveBeenCalledWith("已撤销分享", "success");
  });

  it("shows an empty state", async () => {
    render(
      <MySharesCard
        onClose={vi.fn()}
        onLoad={async () => []}
        onRevoke={vi.fn()}
        onToast={vi.fn()}
      />,
    );

    expect(await screen.findByText("还没有有效的会话分享")).toBeInTheDocument();
  });

  it("shows load and revoke failures without removing the share", async () => {
    const user = userEvent.setup();
    const onLoad = vi
      .fn<() => Promise<typeof share[]>>()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce([share]);
    const onToast = vi.fn();

    render(
      <MySharesCard
        onClose={vi.fn()}
        onLoad={onLoad}
        onRevoke={async () => {
          throw new Error("revoke failed");
        }}
        onToast={onToast}
      />,
    );

    expect(await screen.findByText("分享列表加载失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    const item = await screen.findByRole("article", { name: "项目讨论" });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("copy failed"))) },
      configurable: true,
    });
    await user.click(within(item).getByRole("button", { name: "复制链接" }));
    expect(onToast).toHaveBeenCalledWith("复制失败", "error");

    await user.click(within(item).getByRole("button", { name: "撤销分享" }));

    expect(screen.getByRole("article", { name: "项目讨论" })).toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith("撤销失败", "error");
  });
});
