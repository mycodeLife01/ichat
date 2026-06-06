import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { tokenStore } from "./tokenStore";
import { useAuthSession } from "./useAuthSession";

describe("useAuthSession", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("logs in: calls api, persists token, marks authenticated", async () => {
    const login = vi.fn(async () => authTokenResponse);
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ login })),
    });

    await act(async () => {
      await result.current.login({ identifier: "alice", password: "password123" });
    });

    expect(login).toHaveBeenCalledWith({ identifier: "alice", password: "password123" });
    expect(tokenStore.getAccessToken()).toBe(authTokenResponse.access_token);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.username).toBe("alice");
    expect(result.current.isSubmitting).toBe(false);
  });

  it("login failure: clears submitting and rethrows", async () => {
    const error = new ApiError({ status: 401, message: "登录状态已失效，请重新登录" });
    const login = vi.fn(async () => {
      throw error;
    });
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ login })),
    });

    await act(async () => {
      await expect(
        result.current.login({ identifier: "alice", password: "password123" }),
      ).rejects.toBe(error);
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isSubmitting).toBe(false);
  });

  it("registers: persists token and marks authenticated", async () => {
    const register = vi.fn(async () => authTokenResponse);
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ register })),
    });

    await act(async () => {
      await result.current.register({
        username: "alice",
        email: "alice@example.com",
        password: "password123",
      });
    });

    expect(register).toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("logout: calls api, clears token, resets state", async () => {
    const logout = vi.fn(async () => ({ status: "ok" }));
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ logout })),
    });

    await act(async () => {
      await result.current.login({ identifier: "alice", password: "password123" });
    });
    await act(async () => {
      await result.current.logout();
    });

    expect(logout).toHaveBeenCalledWith(authTokenResponse.refresh_token);
    expect(tokenStore.read()).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });
});
