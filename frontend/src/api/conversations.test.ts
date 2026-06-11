import { describe, expect, it, vi } from "vitest";

import { createConversationApi } from "./conversations";
import type { ApiClient } from "./client";
import {
  conversationDetailResponse,
  conversationResponse,
  sendMessageResponse,
} from "../test/apiFixtures";

function mockClient() {
  return {
    request: vi.fn(),
  } as unknown as Pick<ApiClient, "request">;
}

describe("conversationApi", () => {
  it("lists conversations", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue([conversationResponse]);
    const api = createConversationApi(client);

    await api.list();

    expect(client.request).toHaveBeenCalledWith("/conversations");
  });

  it("creates a conversation with optional title", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(conversationResponse);
    const api = createConversationApi(client);

    await api.create("Draft");

    expect(client.request).toHaveBeenCalledWith("/conversations", {
      method: "POST",
      body: { title: "Draft" },
    });
  });

  it("loads conversation detail", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(conversationDetailResponse);
    const api = createConversationApi(client);

    await api.detail(10);

    expect(client.request).toHaveBeenCalledWith("/conversations/10");
  });

  it("renames and removes conversations", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce(conversationResponse);
    vi.mocked(client.request).mockResolvedValueOnce({ status: "ok" });
    const api = createConversationApi(client);

    await api.rename(10, "Renamed");
    await api.remove(10);

    expect(client.request).toHaveBeenNthCalledWith(1, "/conversations/10", {
      method: "PATCH",
      body: { title: "Renamed" },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "/conversations/10", {
      method: "DELETE",
    });
  });

  it("sends, edits, and regenerates messages with backend paths", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(sendMessageResponse);
    const api = createConversationApi(client);

    await api.sendMessage(10, "Hello");
    await api.editAndRegenerate(10, 501, "Edited");
    await api.regenerate(10, 502);

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "/conversations/10/messages",
      { method: "POST", body: { content: "Hello" } },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "/conversations/10/messages/501/edit-and-regenerate",
      { method: "POST", body: { content: "Edited" } },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "/conversations/10/messages/502/regenerate",
      { method: "POST" },
    );
  });

  it("merges thinking options into request bodies when provided", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(sendMessageResponse);
    const api = createConversationApi(client);
    const options = { thinking_enabled: true, reasoning_effort: "max" } as const;

    await api.sendMessage(10, "Hello", options);
    await api.editAndRegenerate(10, 501, "Edited", options);
    await api.regenerate(10, 502, { thinking_enabled: false });

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "/conversations/10/messages",
      {
        method: "POST",
        body: { content: "Hello", thinking_enabled: true, reasoning_effort: "max" },
      },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "/conversations/10/messages/501/edit-and-regenerate",
      {
        method: "POST",
        body: { content: "Edited", thinking_enabled: true, reasoning_effort: "max" },
      },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "/conversations/10/messages/502/regenerate",
      { method: "POST", body: { thinking_enabled: false } },
    );
  });
});
