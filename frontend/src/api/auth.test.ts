import { describe, expect, it, vi } from "vitest";

import { createAuthApi } from "./auth";
import type { ApiClient } from "./client";
import { authTokenResponse } from "../test/apiFixtures";

function mockClient() {
  return {
    request: vi.fn(),
  } as unknown as Pick<ApiClient, "request">;
}

describe("authApi", () => {
  it("posts register payload", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(authTokenResponse);
    const authApi = createAuthApi(client);

    await authApi.register({
      username: "alice",
      nickname: "Alice",
      email: "alice@example.com",
      password: "password123",
    });

    expect(client.request).toHaveBeenCalledWith("/auth/register", {
      method: "POST",
      body: {
        username: "alice",
        nickname: "Alice",
        email: "alice@example.com",
        password: "password123",
      },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("posts login payload", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(authTokenResponse);
    const authApi = createAuthApi(client);

    await authApi.login({ identifier: "alice", password: "password123" });

    expect(client.request).toHaveBeenCalledWith("/auth/login", {
      method: "POST",
      body: { identifier: "alice", password: "password123" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("posts logout payload", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue({ status: "ok" });
    const authApi = createAuthApi(client);

    await authApi.logout("refresh-token");

    expect(client.request).toHaveBeenCalledWith("/auth/logout", {
      method: "POST",
      body: { refresh_token: "refresh-token" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("updates the profile and invokes account lifecycle commands", async () => {
    const client = mockClient();
    vi.mocked(client.request)
      .mockResolvedValueOnce(authTokenResponse.user)
      .mockResolvedValue({ status: "ok" });
    const authApi = createAuthApi(client);

    await authApi.updateProfile("Alice");
    await authApi.changePassword("old-password", "new-password");
    await authApi.requestAccountDeletion("old-password");
    await authApi.confirmAccountDeletion("token");

    expect(client.request).toHaveBeenNthCalledWith(1, "/auth/me", {
      method: "PATCH",
      body: { nickname: "Alice" },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "/auth/change-password", {
      method: "POST",
      body: { current_password: "old-password", new_password: "new-password" },
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "/auth/request-account-deletion", {
      method: "POST",
      body: { password: "old-password" },
    });
    expect(client.request).toHaveBeenNthCalledWith(4, "/auth/confirm-account-deletion", {
      method: "POST",
      body: { token: "token" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });
});
