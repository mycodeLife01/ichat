import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./client";
import { createShareApi } from "./share";
import { shareLinkResponse } from "../test/apiFixtures";

function mockClient() {
  return {
    request: vi.fn(),
  } as unknown as Pick<ApiClient, "request">;
}

describe("shareApi", () => {
  it("creates a share with an expiry and lists/revokes links", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce(shareLinkResponse);
    vi.mocked(client.request).mockResolvedValueOnce([shareLinkResponse]);
    vi.mocked(client.request).mockResolvedValueOnce({ status: "ok" });
    const api = createShareApi(client);

    await api.create("conv-1", 7);
    await api.list("conv-1");
    await api.revoke("conv-1", "tok");

    expect(client.request).toHaveBeenNthCalledWith(1, "/conversations/conv-1/shares", {
      method: "POST",
      body: { expires_in_days: 7 },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "/conversations/conv-1/shares");
    expect(client.request).toHaveBeenNthCalledWith(3, "/conversations/conv-1/shares/tok", {
      method: "DELETE",
    });
  });

  it("sends expires_in_days null when omitted", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce(shareLinkResponse);
    const api = createShareApi(client);

    await api.create("conv-1");

    expect(client.request).toHaveBeenCalledWith("/conversations/conv-1/shares", {
      method: "POST",
      body: { expires_in_days: null },
    });
  });

  it("reads a public snapshot without auth", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce({
      title: "t",
      messages: [],
      created_at: "2026-05-24T10:05:00Z",
    });
    const api = createShareApi(client);

    await api.getPublic("tok123");

    expect(client.request).toHaveBeenCalledWith("/share/tok123", {
      auth: false,
      retryOnUnauthorized: false,
    });
  });
});
