import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import type { ConversationResponse } from "../api/types";
import { useAppActions, useAppState } from "../app/context";
import { conversationResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { PINNED_CONVERSATION_LIMIT, useConversationMarkers } from "./useConversationMarkers";

const row = (id: string, extra: Partial<ConversationResponse> = {}): ConversationResponse => ({
  ...conversationResponse,
  id,
  title: id,
  ...extra,
});

function setup(
  api: Parameters<typeof createFakeServices>[1],
  items: ConversationResponse[],
  pinned: ConversationResponse[] = [],
) {
  const services = createFakeServices({}, api);
  const { result } = renderHook(
    () => ({ markers: useConversationMarkers(), state: useAppState(), actions: useAppActions() }),
    { wrapper: makeWrapper(services) },
  );
  act(() => {
    result.current.actions.dispatch({
      type: "conversations/listLoaded",
      items,
      pinned,
      hasMore: false,
    });
  });
  return result;
}

describe("useConversationMarkers", () => {
  it("pins through the API and confirms with a success toast", async () => {
    const saved = row("a", { pinned_at: "2026-10-24T00:00:00Z" });
    const setPinned = vi.fn(async () => saved);
    const result = setup({ setPinned }, [row("a")]);

    await act(async () => {
      await result.current.markers.togglePin("a");
    });

    expect(setPinned).toHaveBeenCalledWith("a", true);
    expect(result.current.state.conversationIndex.pinnedItems).toMatchObject([saved]);
    expect(result.current.state.conversationIndex.items).toEqual([]);
    expect(result.current.state.ui.toast).toMatchObject({ message: "已置顶", tone: "success" });
  });

  it("refuses an eleventh pin without calling the API", async () => {
    const setPinned = vi.fn();
    const pinned = Array.from({ length: PINNED_CONVERSATION_LIMIT }, (_, index) =>
      row(`p${index}`, { pinned_at: "2026-10-24T00:00:00Z" }),
    );
    const result = setup({ setPinned }, [row("a")], pinned);

    await act(async () => {
      await result.current.markers.togglePin("a");
    });

    expect(setPinned).not.toHaveBeenCalled();
    expect(result.current.state.ui.toast).toMatchObject({
      message: "最多置顶 10 个对话",
      tone: "warning",
    });
  });

  it("puts the row back when the server rejects the pin", async () => {
    const setPinned = vi.fn(async () => {
      throw new ApiError({ status: 409, code: "PIN_LIMIT_REACHED" });
    });
    const result = setup({ setPinned }, [row("a")]);

    await act(async () => {
      await result.current.markers.togglePin("a");
    });

    expect(result.current.state.conversationIndex.pinnedItems).toEqual([]);
    expect(result.current.state.conversationIndex.items.map((c) => c.id)).toEqual(["a"]);
    expect(result.current.state.ui.toast).toMatchObject({ tone: "warning" });
  });

  it("reports the saved favorite state, or null after a rollback", async () => {
    const setFavorited = vi
      .fn()
      .mockResolvedValueOnce(row("a", { favorited_at: "2026-10-24T00:00:00Z" }))
      .mockRejectedValueOnce(new Error("offline"));
    const result = setup({ setFavorited }, [row("a")]);

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.markers.toggleFavorite("a");
    });
    expect(outcome).toBe(true);
    expect(result.current.state.ui.toast).toMatchObject({ message: "已加入收藏" });

    await act(async () => {
      outcome = await result.current.markers.toggleFavorite("a");
    });
    expect(outcome).toBeNull();
    expect(result.current.state.conversationIndex.items[0].favorited_at).toBe(
      "2026-10-24T00:00:00Z",
    );
    expect(result.current.state.ui.toast).toMatchObject({ tone: "error" });
  });
});
