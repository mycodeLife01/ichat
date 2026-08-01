import { afterEach, describe, expect, it } from "vitest";

import { attachmentDraftStore } from "./draftStore";

afterEach(() => localStorage.clear());

describe("attachmentDraftStore", () => {
  it("scopes drafts by both user and conversation", () => {
    attachmentDraftStore.write(1, "conversation-a", {
      content: "Alice draft",
      attachments: [],
    });
    attachmentDraftStore.write(1, "conversation-b", {
      content: "Second draft",
      attachments: [],
    });
    attachmentDraftStore.write(2, "conversation-a", {
      content: "Bob draft",
      attachments: [],
    });

    expect(attachmentDraftStore.read(1, "conversation-a").content).toBe("Alice draft");
    expect(attachmentDraftStore.read(1, "conversation-b").content).toBe("Second draft");
    expect(attachmentDraftStore.read(2, "conversation-a").content).toBe("Bob draft");
  });

  it("clears another account's drafts on an account switch", () => {
    attachmentDraftStore.write(1, "conversation-a", { content: "Alice", attachments: [] });
    attachmentDraftStore.write(2, "conversation-a", { content: "Bob", attachments: [] });

    attachmentDraftStore.clearOtherUsers(2);

    expect(attachmentDraftStore.read(1, "conversation-a")).toEqual({ content: "", attachments: [] });
    expect(attachmentDraftStore.read(2, "conversation-a").content).toBe("Bob");
  });
});
