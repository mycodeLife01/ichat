import { beforeEach, describe, expect, it } from "vitest";

import { replyQuoteDraftStore } from "./replyQuoteDraftStore";

beforeEach(() => localStorage.clear());

describe("replyQuoteDraftStore", () => {
  it("isolates reply quotes by user and conversation", () => {
    replyQuoteDraftStore.write(1, "conversation-a", {
      source_message_id: "00000000-0000-4000-8000-000000000001",
      excerpt: "first quote",
      source_anchor: { version: 1, start: 3, end: 27 },
    });
    replyQuoteDraftStore.write(1, "conversation-b", {
      source_message_id: "00000000-0000-4000-8000-000000000002",
      excerpt: "second quote",
    });
    replyQuoteDraftStore.write(2, "conversation-a", {
      source_message_id: "00000000-0000-4000-8000-000000000003",
      excerpt: "other user",
    });

    expect(replyQuoteDraftStore.read(1, "conversation-a")?.excerpt).toBe("first quote");
    expect(replyQuoteDraftStore.read(1, "conversation-a")?.source_anchor).toEqual({
      version: 1,
      start: 3,
      end: 27,
    });
    expect(replyQuoteDraftStore.read(1, "conversation-b")?.excerpt).toBe("second quote");
    expect(replyQuoteDraftStore.read(2, "conversation-a")?.excerpt).toBe("other user");
  });

  it("does not persist a quote for a new conversation", () => {
    replyQuoteDraftStore.write(1, null, {
      source_message_id: "00000000-0000-4000-8000-000000000001",
      excerpt: "quote",
    });

    expect(replyQuoteDraftStore.read(1, null)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("removes malformed stored data", () => {
    localStorage.setItem(
      "ichat.reply-quote-draft.v1:1:conversation-a",
      JSON.stringify({ source_message_id: "", excerpt: "quote" }),
    );

    expect(replyQuoteDraftStore.read(1, "conversation-a")).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("keeps a readable legacy quote when its optional anchor is malformed", () => {
    localStorage.setItem(
      "ichat.reply-quote-draft.v1:1:conversation-a",
      JSON.stringify({
        source_message_id: "00000000-0000-4000-8000-000000000001",
        excerpt: "quote",
        source_anchor: { version: 1, start: 20, end: 10 },
      }),
    );

    expect(replyQuoteDraftStore.read(1, "conversation-a")).toEqual({
      source_message_id: "00000000-0000-4000-8000-000000000001",
      excerpt: "quote",
      source_anchor: null,
    });
  });

  it("clears drafts owned by other users", () => {
    replyQuoteDraftStore.write(1, "conversation-a", {
      source_message_id: "00000000-0000-4000-8000-000000000001",
      excerpt: "first",
    });
    replyQuoteDraftStore.write(2, "conversation-a", {
      source_message_id: "00000000-0000-4000-8000-000000000002",
      excerpt: "second",
    });

    replyQuoteDraftStore.clearOtherUsers(2);

    expect(replyQuoteDraftStore.read(1, "conversation-a")).toBeNull();
    expect(replyQuoteDraftStore.read(2, "conversation-a")?.excerpt).toBe("second");
  });
});
