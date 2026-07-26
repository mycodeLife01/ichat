import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { ResetPasswordPage } from "./ResetPasswordPage";

function renderAt(path: string, services = createFakeServices()) {
  return renderWithApp(<ResetPasswordPage />, services, undefined, [path]);
}

describe("ResetPasswordPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows an invalid-link warning when the token is missing", () => {
    renderAt("/reset-password");

    expect(screen.getByRole("heading", { name: "重置链接无效" })).toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(notice).toHaveTextContent("请重新申请重置密码");
    expect(screen.queryByLabelText("新密码")).toBeNull();
  });

  it("resets the password with a valid token and confirms success", async () => {
    const user = userEvent.setup();
    const resetPassword = vi.fn(async () => ({ status: "ok" }));
    renderAt("/reset-password?token=tok123", createFakeServices({ resetPassword }));

    await user.type(screen.getByLabelText("新密码"), "newpassword123");
    await user.type(screen.getByLabelText("确认新密码"), "newpassword123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));

    expect(resetPassword).toHaveBeenCalledWith("tok123", "newpassword123");
    expect(await screen.findByRole("heading", { name: "密码已重置" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "success");
  });

  it("marks the submit button busy while the reset is pending", async () => {
    const user = userEvent.setup();
    let resolveReset!: (value: { status: string }) => void;
    const resetPassword = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          resolveReset = resolve;
        }),
    );
    renderAt("/reset-password?token=tok123", createFakeServices({ resetPassword }));

    await user.type(screen.getByLabelText("新密码"), "newpassword123");
    await user.type(screen.getByLabelText("确认新密码"), "newpassword123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));

    const pending = await screen.findByRole("button", { name: "正在重置密码" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");

    resolveReset({ status: "ok" });
    expect(await screen.findByRole("heading", { name: "密码已重置" })).toBeInTheDocument();
  });

  it("blocks submission when the two passwords do not match", async () => {
    const user = userEvent.setup();
    const resetPassword = vi.fn(async () => ({ status: "ok" }));
    renderAt("/reset-password?token=tok123", createFakeServices({ resetPassword }));

    await user.type(screen.getByLabelText("新密码"), "newpassword123");
    await user.type(screen.getByLabelText("确认新密码"), "different123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));

    expect(screen.getByText("两次输入的密码不一致")).toBeInTheDocument();
    const confirm = screen.getByLabelText("确认新密码");
    expect(confirm).toHaveAttribute("aria-invalid", "true");
    expect(confirm).toHaveAccessibleDescription("两次输入的密码不一致");
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("rejects a password shorter than 8 characters", async () => {
    const user = userEvent.setup();
    const resetPassword = vi.fn(async () => ({ status: "ok" }));
    renderAt("/reset-password?token=tok123", createFakeServices({ resetPassword }));

    await user.type(screen.getByLabelText("新密码"), "short");
    await user.type(screen.getByLabelText("确认新密码"), "short");
    await user.click(screen.getByRole("button", { name: "重置密码" }));

    expect(screen.getByText("密码长度需为 8–128 位")).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("shows a friendly hint when the token is expired or invalid", async () => {
    const user = userEvent.setup();
    const resetPassword = vi.fn(async () => {
      throw new ApiError({ status: 400, detail: "Invalid or expired reset link" });
    });
    renderAt("/reset-password?token=stale", createFakeServices({ resetPassword }));

    await user.type(screen.getByLabelText("新密码"), "newpassword123");
    await user.type(screen.getByLabelText("确认新密码"), "newpassword123");
    await user.click(screen.getByRole("button", { name: "重置密码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("重置链接无效或已过期");
  });
});
