import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { ConfirmAccountDeletionPage } from "./ConfirmAccountDeletionPage";

function renderAt(path: string, services = createFakeServices()) {
  return renderWithApp(<ConfirmAccountDeletionPage />, services, undefined, [path]);
}

describe("ConfirmAccountDeletionPage", () => {
  it("announces progress while the confirmation is pending", () => {
    const confirmAccountDeletion = vi.fn(() => new Promise<{ status: string }>(() => {}));
    renderAt("/confirm-deletion?token=tok123", createFakeServices({ confirmAccountDeletion }));

    expect(screen.getByRole("status")).toHaveTextContent("正在确认注销…");
    expect(confirmAccountDeletion).toHaveBeenCalledWith("tok123");
  });

  it("confirms the deletion and shows a persistent success state", async () => {
    const confirmAccountDeletion = vi.fn(async () => ({ status: "ok" }));
    renderAt("/confirm-deletion?token=tok123", createFakeServices({ confirmAccountDeletion }));

    expect(await screen.findByRole("heading", { name: "账号已停用" })).toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("data-tone", "success");
    expect(notice).toHaveTextContent("你的登录凭证已失效");
    expect(screen.getByRole("link", { name: "返回登录" })).toBeInTheDocument();
  });

  it("shows a warning when the link is expired or invalid", async () => {
    const confirmAccountDeletion = vi.fn(async () => {
      throw new ApiError({ status: 400, detail: "Invalid or expired deletion link" });
    });
    renderAt("/confirm-deletion?token=stale", createFakeServices({ confirmAccountDeletion }));

    expect(await screen.findByRole("heading", { name: "注销链接不可用" })).toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(notice).toHaveTextContent("账号状态未发生变化");
    expect(screen.getByRole("link", { name: "返回 iChat" })).toBeInTheDocument();
  });

  it("shows the warning without calling the API when the token is missing", () => {
    const confirmAccountDeletion = vi.fn(async () => ({ status: "ok" }));
    renderAt("/confirm-deletion", createFakeServices({ confirmAccountDeletion }));

    expect(screen.getByRole("heading", { name: "注销链接不可用" })).toBeInTheDocument();
    expect(confirmAccountDeletion).not.toHaveBeenCalled();
  });
});
