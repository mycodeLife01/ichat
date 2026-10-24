import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppActions, useAppState } from "../app/context";
import type { ConversationResponse } from "../api/types";
import { createAuthSession } from "../auth/tokenStore";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper, withNoPins } from "../test/appHarness";
import { useConversationListSync } from "./useConversationListSync";

const row = (id: string, extra: Partial<ConversationResponse> = {}): ConversationResponse => ({
  id,
  title: `Title ${id}`,
  activated_at: "2026-10-01T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...extra,
});

function useSyncProbe() {
  useConversationListSync();
  const { conversationIndex } = useAppState();
  const { dispatch } = useAppActions();
  return { conversationIndex, dispatch };
}

function setup(list: () => Promise<ConversationResponse[]>) {
  const listMock = vi.fn(list);
  const services = createFakeServices({}, { list: withNoPins(listMock) });
  const { result } = renderHook(() => useSyncProbe(), { wrapper: makeWrapper(services) });
  act(() => {
    result.current.dispatch({
      type: "auth/loggedIn",
      session: createAuthSession(authTokenResponse),
    });
  });
  return { result, listMock };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useConversationListSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll when nothing is outstanding", async () => {
    const { listMock } = setup(async () => []);
    await advance(10_000);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("polls every second until a pending title lands", async () => {
    let title: string | null = null;
    const { result, listMock } = setup(async () => [row("a", { title })]);
    act(() => {
      result.current.dispatch({
        type: "conversations/listLoaded",
        items: [row("a", { title: null })],
      });
      result.current.dispatch({ type: "conversations/titlePending", id: "a" });
    });

    await advance(1000);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(result.current.conversationIndex.pendingTitleIds).toEqual(["a"]);

    title = "Backend Plan";
    await advance(1000);
    expect(result.current.conversationIndex.items[0].title).toBe("Backend Plan");
    expect(result.current.conversationIndex.pendingTitleIds).toEqual([]);

    await advance(10_000);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a title after the timeout", async () => {
    const { result } = setup(async () => [row("a", { title: null })]);
    act(() => {
      result.current.dispatch({ type: "conversations/titlePending", id: "a" });
    });

    await advance(20_000);
    expect(result.current.conversationIndex.pendingTitleIds).toEqual([]);
  });

  it("polls a background run and marks it unread when it finishes", async () => {
    let activeRun: ConversationResponse["active_run"] = { id: "run-b", status: "streaming" };
    const { result, listMock } = setup(async () => [row("b", { active_run: activeRun })]);
    act(() => {
      result.current.dispatch({ type: "conversations/selected", id: "a" });
      result.current.dispatch({
        type: "conversations/listLoaded",
        items: [row("b", { active_run: activeRun })],
      });
    });

    await advance(1000);
    expect(listMock).not.toHaveBeenCalled();
    await advance(2000);
    expect(listMock).toHaveBeenCalledTimes(1);

    activeRun = null;
    await advance(3000);
    expect(result.current.conversationIndex.items[0].active_run).toBeNull();
    expect(result.current.conversationIndex.unreadIds).toEqual(["b"]);

    await advance(10_000);
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
