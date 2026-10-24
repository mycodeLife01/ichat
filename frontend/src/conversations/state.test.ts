import { describe, expect, it } from "vitest";
import type { ConversationResponse } from "../api/types";

import {
  conversationDetailResponse,
  conversationResponse,
  sendMessageResponse,
} from "../test/apiFixtures";
import {
  conversationDetailReducer,
  conversationIndexReducer,
  initialConversationDetailState,
  initialConversationIndexState,
} from "./state";

describe("conversationIndexReducer", () => {
  it("sets loading then loaded with items", () => {
    const loading = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoading",
    });
    expect(loading.status).toBe("loading");

    const loaded = conversationIndexReducer(loading, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
      hasMore: true,
    });
    expect(loaded.status).toBe("idle");
    expect(loaded.items).toEqual([conversationResponse]);
    expect(loaded.hasMore).toBe(true);
  });

  it("appends a page and deduplicates conversations", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
      hasMore: true,
    });
    const next = conversationIndexReducer(base, {
      type: "conversations/listPageLoaded",
      items: [
        conversationResponse,
        { ...conversationResponse, id: "11", title: "Second chat" },
      ],
      hasMore: false,
    });

    expect(next.status).toBe("idle");
    expect(next.items.map((item) => item.id)).toEqual(["10", "11"]);
    expect(next.hasMore).toBe(false);
  });

  it("sets error status", () => {
    const next = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listError",
    });
    expect(next.status).toBe("error");
  });

  it("selects a conversation and the new (null) state", () => {
    const selected = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/selected",
      id: "10",
    });
    expect(selected.selectedId).toBe("10");

    const cleared = conversationIndexReducer(selected, {
      type: "conversations/selected",
      id: null,
    });
    expect(cleared.selectedId).toBeNull();
  });

  it("replaces a renamed item in place", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    const renamed = { ...conversationResponse, title: "新标题" };
    const next = conversationIndexReducer(base, {
      type: "conversations/renamed",
      conversation: renamed,
    });
    expect(next.items[0].title).toBe("新标题");
  });

  it("removes an item", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    const next = conversationIndexReducer(base, {
      type: "conversations/removed",
      id: conversationResponse.id,
    });
    expect(next.items).toHaveLength(0);
  });

  it("resets to initial on app/reset", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    const next = conversationIndexReducer(base, { type: "app/reset" });
    expect(next).toEqual(initialConversationIndexState);
  });
});

describe("conversationDetailReducer", () => {
  const { messages, ...conversation } = conversationDetailResponse;

  it("loads detail into ready state", () => {
    const loading = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoading",
    });
    expect(loading.status).toBe("loading");

    const ready = conversationDetailReducer(loading, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    expect(ready.status).toBe("ready");
    expect(ready.conversation).toEqual(conversation);
    expect(ready.messages).toEqual(messages);
  });

  it("clears to forbidden", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    const next = conversationDetailReducer(ready, {
      type: "conversations/detailForbidden",
    });
    expect(next.status).toBe("forbidden");
    expect(next.conversation).toBeNull();
    expect(next.messages).toEqual([]);
  });

  it("resets to initial on detailReset and app/reset", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    expect(
      conversationDetailReducer(ready, { type: "conversations/detailReset" }),
    ).toEqual(initialConversationDetailState);
    expect(conversationDetailReducer(ready, { type: "app/reset" })).toEqual(
      initialConversationDetailState,
    );
  });

  it("syncs the current conversation on rename", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    const renamed = { ...conversation, title: "改名后" };
    const next = conversationDetailReducer(ready, {
      type: "conversations/renamed",
      conversation: renamed,
    });
    expect(next.conversation?.title).toBe("改名后");
  });
});

describe("conversation slices - streaming additions", () => {
  it("appends a message to detail", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation: conversationResponse,
      messages: [],
    });
    const next = conversationDetailReducer(ready, {
      type: "conversations/messageAppended",
      message: sendMessageResponse.message,
    });
    expect(next.messages).toEqual([sendMessageResponse.message]);
  });

  it("sets and clears draftId", () => {
    const created = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/draftCreated",
      id: "42",
    });
    expect(created.draftId).toBe("42");
    const activated = conversationIndexReducer(created, {
      type: "conversations/draftActivated",
    });
    expect(activated.draftId).toBeNull();
  });

  it("adds and removes title-pending ids without duplicates", () => {
    const one = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/titlePending",
      id: "7",
    });
    expect(one.pendingTitleIds).toEqual(["7"]);
    // Idempotent: re-adding the same id does not duplicate it.
    const stillOne = conversationIndexReducer(one, {
      type: "conversations/titlePending",
      id: "7",
    });
    expect(stillOne.pendingTitleIds).toEqual(["7"]);
    const two = conversationIndexReducer(stillOne, {
      type: "conversations/titlePending",
      id: "9",
    });
    expect(two.pendingTitleIds).toEqual(["7", "9"]);
    const resolved = conversationIndexReducer(two, {
      type: "conversations/titleResolved",
      id: "7",
    });
    expect(resolved.pendingTitleIds).toEqual(["9"]);
  });

  it("clears pendingTitleIds on app/reset", () => {
    const pending = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/titlePending",
      id: "7",
    });
    const reset = conversationIndexReducer(pending, { type: "app/reset" });
    expect(reset.pendingTitleIds).toEqual([]);
  });
});

describe("conversation run status", () => {
  const convo = (id: string, extra: Partial<ConversationResponse> = {}): ConversationResponse => ({
    ...conversationResponse,
    id,
    title: `Title ${id}`,
    updated_at: "2026-10-01T00:00:00Z",
    ...extra,
  });
  const run = { id: "run-1", status: "queued" as const };

  it("inserts a new untitled conversation at the top, running and title-pending", () => {
    const base = { ...initialConversationIndexState, items: [convo("a")] };
    const next = conversationIndexReducer(base, {
      type: "conversations/runStarted",
      conversation: convo("b", { title: null }),
      run,
      updatedAt: "2026-10-02T00:00:00Z",
    });
    expect(next.items.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next.items[0].active_run).toEqual(run);
    expect(next.items[0].updated_at).toBe("2026-10-02T00:00:00Z");
    expect(next.pendingTitleIds).toEqual(["b"]);
  });

  it("moves an existing conversation to the top without marking its title pending", () => {
    const base = { ...initialConversationIndexState, items: [convo("a"), convo("b")] };
    const next = conversationIndexReducer(base, {
      type: "conversations/runStarted",
      conversation: convo("b"),
      run,
      updatedAt: "2026-10-02T00:00:00Z",
    });
    expect(next.items.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next.pendingTitleIds).toEqual([]);
  });

  it("marks a finished run unread only when its conversation is not open", () => {
    const base = {
      ...initialConversationIndexState,
      selectedId: "a",
      items: [
        convo("a", { active_run: run }),
        convo("b", { active_run: { ...run, id: "run-2" } }),
      ],
    };
    const afterOpen = conversationIndexReducer(base, {
      type: "conversations/runFinished",
      id: "a",
    });
    expect(afterOpen.items[0].active_run).toBeNull();
    expect(afterOpen.unreadIds).toEqual([]);

    const afterBackground = conversationIndexReducer(afterOpen, {
      type: "conversations/runFinished",
      id: "b",
    });
    expect(afterBackground.unreadIds).toEqual(["b"]);

    const entered = conversationIndexReducer(afterBackground, {
      type: "conversations/selected",
      id: "b",
    });
    expect(entered.unreadIds).toEqual([]);
  });

  it("marks unread when a synced list shows a background run gone", () => {
    const base = {
      ...initialConversationIndexState,
      selectedId: "a",
      items: [convo("a"), convo("b", { active_run: run })],
    };
    const next = conversationIndexReducer(base, {
      type: "conversations/listSynced",
      items: [convo("a"), convo("b")],
    });
    expect(next.items[1].active_run).toBeFalsy();
    expect(next.unreadIds).toEqual(["b"]);
  });

  it("keeps rows beyond the first page and newer local rows when syncing", () => {
    const base = {
      ...initialConversationIndexState,
      hasMore: true,
      items: [
        convo("a", { updated_at: "2026-10-03T00:00:00Z", active_run: run }),
        convo("old"),
      ],
    };
    const next = conversationIndexReducer(base, {
      type: "conversations/listSynced",
      items: [convo("a", { updated_at: "2026-10-02T00:00:00Z" })],
    });
    expect(next.items.map((c) => c.id)).toEqual(["a", "old"]);
    expect(next.items[0].active_run).toEqual(run);
    expect(next.hasMore).toBe(true);
    expect(next.unreadIds).toEqual([]);
  });

  it("resolves a pending title once the synced row has one and syncs detail", () => {
    const index = conversationIndexReducer(
      {
        ...initialConversationIndexState,
        items: [convo("a", { title: null })],
        pendingTitleIds: ["a"],
      },
      { type: "conversations/listSynced", items: [convo("a", { title: "Backend Plan" })] },
    );
    expect(index.items[0].title).toBe("Backend Plan");
    expect(index.pendingTitleIds).toEqual([]);

    const detail = conversationDetailReducer(
      { ...initialConversationDetailState, conversation: convo("a", { title: null }) },
      { type: "conversations/listSynced", items: [convo("a", { title: "Backend Plan" })] },
    );
    expect(detail.conversation?.title).toBe("Backend Plan");
  });

  it("drops a removed conversation from unread", () => {
    const next = conversationIndexReducer(
      { ...initialConversationIndexState, items: [convo("a")], unreadIds: ["a"] },
      { type: "conversations/removed", id: "a" },
    );
    expect(next.unreadIds).toEqual([]);
  });
});
