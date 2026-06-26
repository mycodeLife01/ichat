import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "./tokenStore";
import { VerifyEmailPage } from "./VerifyEmailPage";

function renderAt(path: string, services = createFakeServices()) {
  return renderWithApp(<VerifyEmailPage />, services, undefined, [path]);
}

describe("VerifyEmailPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("verifies the token and shows success", async () => {
    const verifyEmail = vi.fn(async () => ({ status: "ok" }));
    renderAt("/verify-email?token=abc123", createFakeServices({ verifyEmail }));

    expect(await screen.findByText("邮箱验证成功")).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledWith("abc123");
  });

  it("refreshes the user mirror when logged in", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const me = vi.fn(async () => ({ ...authTokenResponse.user, email_verified: true }));
    const verifyEmail = vi.fn(async () => ({ status: "ok" }));
    renderAt("/verify-email?token=abc123", createFakeServices({ verifyEmail, me }));

    expect(await screen.findByText("邮箱验证成功")).toBeInTheDocument();
    await waitFor(() => expect(me).toHaveBeenCalled());
  });

  it("shows a generic failure for an invalid token", async () => {
    const verifyEmail = vi.fn(async () => {
      throw new ApiError({ status: 400, detail: "Invalid or expired verification link" });
    });
    renderAt("/verify-email?token=bad", createFakeServices({ verifyEmail }));

    expect(await screen.findByText("验证链接已失效或不可用")).toBeInTheDocument();
    // Logged out: no resend button, just a way back.
    expect(screen.queryByRole("button", { name: "重新发送验证邮件" })).toBeNull();
    expect(screen.getByRole("link", { name: "前往 iChat" })).toBeInTheDocument();
  });

  it("offers resend on failure when logged in but unverified", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));
    const me = vi.fn(async () => authTokenResponse.user); // still unverified
    const verifyEmail = vi.fn(async () => {
      throw new ApiError({ status: 400 });
    });
    renderAt("/verify-email?token=bad", createFakeServices({ verifyEmail, me }));

    expect(await screen.findByText("验证链接已失效或不可用")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "重新发送验证邮件" }),
    ).toBeInTheDocument();
  });
});
