import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { App } from "./App";

describe("App auth gate", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows the auth screen when unauthenticated", async () => {
    renderWithApp(<App />, createFakeServices());

    expect(await screen.findByRole("tab", { name: "登录" })).toBeInTheDocument();
  });

  it("shows the chat shell when a session is restored", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    // The empty-state welcome heading appears in the chat shell.
    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
  });

  it("returns to the auth screen after logout", async () => {
    const user = userEvent.setup();
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    await user.click(await screen.findByRole("button", { name: "打开个人中心" }));
    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    const dialog = screen.getByRole("dialog", { name: "你确定要退出登录吗？" });
    await user.click(within(dialog).getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("tab", { name: "登录" })).toBeInTheDocument();
    expect(tokenStore.read()).toBeNull();
  });

  it("renders the public share page without authentication", async () => {
    // No session in localStorage and no token-keyed selection. The /share/:token
    // route must render the snapshot, never the auth screen.
    const services = createFakeServices(
      {},
      {},
      {},
      {},
      {
        getPublic: async () => ({
          title: "Shared chat",
          messages: [{ role: "user", content: "shared question", sources: [] }],
          created_at: "2026-05-24T10:05:00Z",
        }),
      },
    );

    renderWithApp(<App />, services, undefined, ["/share/tok123"]);

    expect(await screen.findByText("shared question")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "登录" })).toBeNull();
  });

  it("confirms account deletion publicly and clears a local session", async () => {
    const confirmAccountDeletion = vi.fn(async () => ({ status: "ok" }));
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(
      <App />,
      createFakeServices({ confirmAccountDeletion }),
      undefined,
      ["/confirm-account-deletion?token=delete-token"],
    );

    expect(await screen.findByRole("heading", { name: "账号已停用" })).toBeInTheDocument();
    expect(confirmAccountDeletion).toHaveBeenCalledWith("delete-token");
    expect(tokenStore.read()).toBeNull();
  });

  it("shows an error for an invalid account deletion token", async () => {
    renderWithApp(
      <App />,
      createFakeServices({
        confirmAccountDeletion: async () => {
          throw new Error("invalid token");
        },
      }),
      undefined,
      ["/confirm-account-deletion?token=invalid-token"],
    );

    expect(await screen.findByRole("heading", { name: "注销链接不可用" })).toBeInTheDocument();
    expect(screen.getByText("链接可能已过期、已使用或无效，账号状态未发生变化。")).toBeInTheDocument();
  });
});
