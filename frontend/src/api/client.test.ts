import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "./client";
import { ApiError } from "./errors";
import { tokenStore } from "../auth/tokenStore";
import { authTokenResponse, conversationResponse, envelope } from "../test/apiFixtures";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("ApiClient JSON requests", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads data from success envelopes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(envelope(conversationResponse)));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl });

    await expect(client.request("/conversations")).resolves.toEqual(conversationResponse);
  });

  it("builds method, JSON body, query, and authorization headers", async () => {
    tokenStore.save({
      user: authTokenResponse.user,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "bearer",
      expiresAt: Date.now() + 3600_000,
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(envelope(conversationResponse)));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl, tokenStore });

    await client.request("/conversations/10", {
      method: "PATCH",
      body: { title: "Renamed" },
      query: { after_seq: 2 },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.test/api/v1/conversations/10?after_seq=2",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("throws ApiError for non-2xx JSON responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ detail: "active run exists" }, { status: 409 }),
    );
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl });

    await expect(client.request("/conversations")).rejects.toMatchObject({
      status: 409,
      detail: "active run exists",
    });
  });

  it("throws ApiError when success envelope has no data field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl });

    await expect(client.request("/conversations")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("ApiClient refresh retry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("refreshes once and retries the original request after 401", async () => {
    tokenStore.save({
      user: authTokenResponse.user,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "bearer",
      expiresAt: Date.now() - 1,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            ...authTokenResponse,
            access_token: "new-access",
            refresh_token: "new-refresh",
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(envelope(conversationResponse)));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl, tokenStore });

    await expect(client.request("/conversations")).resolves.toEqual(conversationResponse);
    expect(tokenStore.getAccessToken()).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("clears tokens and calls onAuthExpired when refresh fails", async () => {
    tokenStore.save({
      user: authTokenResponse.user,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "bearer",
      expiresAt: Date.now() - 1,
    });
    const onAuthExpired = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ detail: "invalid refresh" }, { status: 401 }));
    const client = new ApiClient({
      baseUrl: "http://api.test/api/v1",
      fetchImpl,
      tokenStore,
      onAuthExpired,
    });

    await expect(client.request("/conversations")).rejects.toMatchObject({
      status: 401,
      isAuthExpired: true,
    });
    expect(tokenStore.read()).toBeNull();
    expect(onAuthExpired).toHaveBeenCalledOnce();
  });
});
