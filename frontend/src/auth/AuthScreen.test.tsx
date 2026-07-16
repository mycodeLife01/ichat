import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { AuthScreen } from "./AuthScreen";

describe("AuthScreen", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders only the fields for the active mode", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    expect(screen.getByLabelText("用户名或邮箱")).toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("昵称（可选）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "注册" }));

    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
    expect(screen.getByLabelText("昵称（可选）")).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.queryByLabelText("用户名或邮箱")).not.toBeInTheDocument();
  });

  it("animates only the outer card height when switching modes", async () => {
    const user = userEvent.setup();
    const { container } = renderWithApp(<AuthScreen />, createFakeServices());
    const card = container.querySelector("section");
    expect(card).not.toBeNull();
    if (!card) return;

    vi.spyOn(card, "getBoundingClientRect")
      .mockReturnValueOnce({ height: 420 } as DOMRect)
      .mockReturnValueOnce({ height: 620 } as DOMRect);
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    Object.defineProperty(card, "animate", { configurable: true, value: animate });

    await user.click(screen.getByRole("tab", { name: "注册" }));

    expect(animate).toHaveBeenCalledWith(
      [{ height: "420px" }, { height: "620px" }],
      {
        duration: 320,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    );
  });

  it("skips the card animation when reduced motion is preferred", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    const { container } = renderWithApp(<AuthScreen />, createFakeServices());
    const card = container.querySelector("section");
    expect(card).not.toBeNull();
    if (!card) return;

    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ height: 420 } as DOMRect);
    const animate = vi.fn();
    Object.defineProperty(card, "animate", { configurable: true, value: animate });

    await user.click(screen.getByRole("tab", { name: "注册" }));

    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
    expect(animate).not.toHaveBeenCalled();
  });

  it("shows field errors when submitting an empty login form", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => authTokenResponse);
    renderWithApp(<AuthScreen />, createFakeServices({ login }));

    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(screen.getByText("请输入用户名或邮箱")).toBeInTheDocument();
    expect(screen.getByText("密码长度需为 8–128 位")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects an invalid email on register", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    await user.click(screen.getByRole("tab", { name: "注册" }));
    await user.type(screen.getByLabelText("用户名"), "alice");
    await user.type(screen.getByLabelText("邮箱"), "not-an-email");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "注册" }));

    expect(screen.getByText("请输入有效的邮箱地址")).toBeInTheDocument();
  });

  it("submits a valid registration with a trimmed nickname", async () => {
    const user = userEvent.setup();
    const register = vi.fn(async () => authTokenResponse);
    renderWithApp(<AuthScreen />, createFakeServices({ register }));

    await user.click(screen.getByRole("tab", { name: "注册" }));
    await user.type(screen.getByLabelText("用户名"), "  alice  ");
    await user.type(screen.getByLabelText("昵称（可选）"), "  Alice Cooper  ");
    await user.type(screen.getByLabelText("邮箱"), "  alice@example.com  ");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "注册" }));

    expect(register).toHaveBeenCalledWith({
      username: "alice",
      nickname: "Alice Cooper",
      email: "alice@example.com",
      password: "password123",
    });
  });

  it("uses the username as nickname when registration nickname is blank", async () => {
    const user = userEvent.setup();
    const register = vi.fn(async () => authTokenResponse);
    renderWithApp(<AuthScreen />, createFakeServices({ register }));

    await user.click(screen.getByRole("tab", { name: "注册" }));
    await user.type(screen.getByLabelText("用户名"), "alice");
    await user.type(screen.getByLabelText("邮箱"), "alice@example.com");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "注册" }));

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ nickname: "alice" }));
  });

  it("submits a valid login with trimmed values", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => authTokenResponse);
    renderWithApp(<AuthScreen />, createFakeServices({ login }));

    await user.type(screen.getByLabelText("用户名或邮箱"), "  alice  ");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(login).toHaveBeenCalledWith({ identifier: "alice", password: "password123" });
  });

  it("shows a form error message on login 401", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => {
      throw new ApiError({ status: 401 });
    });
    renderWithApp(<AuthScreen />, createFakeServices({ login }));

    await user.type(screen.getByLabelText("用户名或邮箱"), "alice");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
  });

  it("shows a username field error on register 409", async () => {
    const user = userEvent.setup();
    const register = vi.fn(async () => {
      throw new ApiError({ status: 409, detail: "Username is already registered" });
    });
    renderWithApp(<AuthScreen />, createFakeServices({ register }));

    await user.click(screen.getByRole("tab", { name: "注册" }));
    await user.type(screen.getByLabelText("用户名"), "alice");
    await user.type(screen.getByLabelText("邮箱"), "alice@example.com");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByText("该用户名已被注册")).toBeInTheDocument();
  });

  it("clears errors when switching modes", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(screen.getByText("请输入用户名或邮箱")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "注册" }));
    expect(screen.queryByText("请输入用户名或邮箱")).not.toBeInTheDocument();
  });

  it("sends a password reset request and shows the anti-enumeration notice", async () => {
    const user = userEvent.setup();
    const requestPasswordReset = vi.fn(async () => ({ status: "ok" }));
    renderWithApp(<AuthScreen />, createFakeServices({ requestPasswordReset }));

    await user.click(screen.getByRole("button", { name: "忘记密码？" }));
    // The login/register tabs are hidden in the forgot view.
    expect(screen.queryByRole("tab", { name: "登录" })).toBeNull();

    await user.type(screen.getByLabelText("邮箱"), "  alice@example.com  ");
    await user.click(screen.getByRole("button", { name: "发送重置链接" }));

    expect(requestPasswordReset).toHaveBeenCalledWith("alice@example.com");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "我们已发送一封包含重置链接的邮件",
    );
  });

  it("rejects an invalid email before requesting a reset", async () => {
    const user = userEvent.setup();
    const requestPasswordReset = vi.fn(async () => ({ status: "ok" }));
    renderWithApp(<AuthScreen />, createFakeServices({ requestPasswordReset }));

    await user.click(screen.getByRole("button", { name: "忘记密码？" }));
    await user.type(screen.getByLabelText("邮箱"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "发送重置链接" }));

    expect(screen.getByText("请输入有效的邮箱地址")).toBeInTheDocument();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("surfaces a rate-limit error when the reset request is throttled", async () => {
    const user = userEvent.setup();
    const requestPasswordReset = vi.fn(async () => {
      throw new ApiError({ status: 429 });
    });
    renderWithApp(<AuthScreen />, createFakeServices({ requestPasswordReset }));

    await user.click(screen.getByRole("button", { name: "忘记密码？" }));
    await user.type(screen.getByLabelText("邮箱"), "alice@example.com");
    await user.click(screen.getByRole("button", { name: "发送重置链接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("操作过于频繁，请稍后再试");
  });
});
