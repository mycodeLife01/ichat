import { describe, expect, it } from "vitest";

import {
  conversationDetailResponse,
  conversationResponse,
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
    });
    expect(loaded.status).toBe("idle");
    expect(loaded.items).toEqual([conversationResponse]);
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
      id: 10,
    });
    expect(selected.selectedId).toBe(10);

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
