import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { AuthScreen } from "./AuthScreen";

describe("AuthScreen", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("activates login fields by default and register fields after switching", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    // Mode-specific fields stay mounted (to animate the card height); the
    // inactive set is collapsed and removed from the tab order.
    expect(screen.getByLabelText("用户名或邮箱")).toHaveAttribute("tabindex", "0");
    expect(screen.getByLabelText("邮箱")).toHaveAttribute("tabindex", "-1");

    await user.click(screen.getByRole("tab", { name: "注册" }));

    expect(screen.getByLabelText("用户名")).toHaveAttribute("tabindex", "0");
    expect(screen.getByLabelText("邮箱")).toHaveAttribute("tabindex", "0");
    expect(screen.getByLabelText("用户名或邮箱")).toHaveAttribute("tabindex", "-1");
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
});
