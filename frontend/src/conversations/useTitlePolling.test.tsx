import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationDetailResponse } from "../api/types";
import { useAppActions, useAppState } from "../app/context";
import { conversationResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { useTitlePolling } from "./useTitlePolling";

const cid = conversationResponse.id;

function detailWithTitle(title: string | null): ConversationDetailResponse {
  return { ...conversationResponse, title, messages: [] };
}

function useTitleProbe() {
  const poll = useTitlePolling();
  const { dispatch } = useAppActions();
  const { conversationIndex, conversationDetail } = useAppState();
  return {
    poll,
    dispatch,
    pendingTitleIds: conversationIndex.pendingTitleIds,
    detailConversation: conversationDetail.conversation,
  };
}

const immediate = () => Promise.resolve();

describe("useTitlePolling", () => {
  it("marks the conversation pending while polling and resolves on timeout", async () => {
    let release: () => void = () => {};
    const sleep = vi.fn(() => new Promise<void>((r) => (release = r)));
    const detail = vi.fn(async () => detailWithTitle(null));
    const services = createFakeServices({}, { detail });
    const { result } = renderHook(() => useTitleProbe(), { wrapper: makeWrapper(services) });

    let polled: Promise<void> = Promise.resolve();
    await act(async () => {
      polled = result.current.poll(cid, { attempts: 1, sleep });
      await Promise.resolve();
    });
    // Skeleton is showing: id is pending while the poll is parked in sleep.
    expect(result.current.pendingTitleIds).toContain(cid);

    await act(async () => {
      release();
      await polled;
    });
    // One attempt, still no title → pending cleared (falls back to 新对话).
    expect(result.current.pendingTitleIds).not.toContain(cid);
  });

  it("refreshes the list and resolves when the title appears", async () => {
    let calls = 0;
    const detail = vi.fn(async () => detailWithTitle(calls++ === 0 ? null : "自动标题"));
    const list = vi.fn(async () => [{ ...conversationResponse, title: "自动标题" }]);
    const services = createFakeServices({}, { detail, list });
    const { result } = renderHook(() => useTitleProbe(), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.poll(cid, { sleep: immediate });
    });

    expect(detail).toHaveBeenCalledTimes(2); // polled until the title showed up
    expect(list).toHaveBeenCalledWith({ limit: 30, skip: 0 }); // sidebar refreshed
    expect(result.current.pendingTitleIds).not.toContain(cid);
  });

  it("syncs the loaded detail's title so the topbar updates without a reload", async () => {
    const detail = vi.fn(async () => detailWithTitle("自动标题"));
    const list = vi.fn(async () => [{ ...conversationResponse, title: "自动标题" }]);
    const services = createFakeServices({}, { detail, list });
    const { result } = renderHook(() => useTitleProbe(), { wrapper: makeWrapper(services) });

    // The conversation is open in the thread (topbar reads this state), still untitled.
    await act(async () => {
      result.current.dispatch({
        type: "conversations/detailLoaded",
        conversation: { ...conversationResponse, title: null },
        messages: [],
      });
    });

    await act(async () => {
      await result.current.poll(cid, { sleep: immediate });
    });

    expect(result.current.detailConversation?.title).toBe("自动标题");
  });

  it("resolves (clears pending) when a detail poll fails", async () => {
    const detail = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { detail });
    const { result } = renderHook(() => useTitleProbe(), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.poll(cid, { sleep: immediate });
    });

    expect(result.current.pendingTitleIds).not.toContain(cid);
  });

  it("does not start a second poller for the same conversation", async () => {
    let release: () => void = () => {};
    const sleep = vi.fn(() => new Promise<void>((r) => (release = r)));
    const detail = vi.fn(async () => detailWithTitle(null));
    const services = createFakeServices({}, { detail });
    const { result } = renderHook(() => useTitleProbe(), { wrapper: makeWrapper(services) });

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.poll(cid, { attempts: 1, sleep });
      await Promise.resolve();
    });
    // Second call while already pending is a no-op (no extra sleep/poll scheduled).
    await act(async () => {
      await result.current.poll(cid, { attempts: 1, sleep });
    });
    expect(sleep).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await first;
    });
  });
});
