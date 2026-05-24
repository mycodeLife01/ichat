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
      email: "alice@example.com",
      password: "password123",
    });

    expect(client.request).toHaveBeenCalledWith("/auth/register", {
      method: "POST",
      body: {
        username: "alice",
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
});
