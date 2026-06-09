import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAppActions, useAppState } from "../app/context";
import {
  conversationDetailResponse,
  conversationResponse,
  reasoningDeltaEvent,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { createFakeServices, fakeStream, makeWrapper } from "../test/appHarness";
import { useRunStream } from "./useRunStream";

function useStreamProbe() {
  const { start, cancel } = useRunStream();
  const { activeRun, conversationDetail } = useAppState();
  const { dispatch } = useAppActions();
  return { start, cancel, activeRun, conversationDetail, dispatch };
}

describe("useRunStream", () => {
  it("replaces with server detail on success when still on that conversation", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices(
      {},
      { detail, list },
      {
        streamEvents: () =>
          fakeStream([
            { ...reasoningDeltaEvent, seq: 1 },
            { ...textDeltaEvent, seq: 2 },
            { ...succeededEvent, seq: 3 },
          ]),
      },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: conversationResponse.id });
    });
    await act(async () => {
      await result.current.start(100, conversationResponse.id, 0);
    });

    expect(detail).toHaveBeenCalledWith(conversationResponse.id);
    expect(list).toHaveBeenCalled();
    expect(result.current.activeRun).toBeNull();
    expect(result.current.conversationDetail.messages).toEqual(
      conversationDetailResponse.messages,
    );
  });

  it("does not apply detail when the user navigated away", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices(
      {},
      { detail, list },
      { streamEvents: () => fakeStream([{ ...succeededEvent, seq: 1 }]) },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    // selectedId stays null while the run targets conversation 10.
    await act(async () => {
      await result.current.start(100, conversationResponse.id, 0);
    });

    expect(detail).toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
    // detailLoaded skipped: detail not applied to the (different) current view.
    expect(result.current.conversationDetail.messages).toEqual([]);
  });

  it("does not refetch detail on failure", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const services = createFakeServices(
      {},
      { detail },
      {
        streamEvents: () =>
          fakeStream([{ seq: 1, type: "run_failed", payload: {}, created_at: "x" }]),
      },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.start(100, conversationResponse.id, 0);
    });

    expect(detail).not.toHaveBeenCalled();
  });

  it("requests cancellation and flips to stopping", async () => {
    const cancel = vi.fn(async () => ({ status: "ok" }));
    const services = createFakeServices({}, {}, { cancel });
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: 100, conversationId: 10 });
    });
    await act(async () => {
      await result.current.cancel(100);
    });

    expect(cancel).toHaveBeenCalledWith(100);
    expect(result.current.activeRun?.cancelRequested).toBe(true);
    expect(result.current.activeRun?.status).toBe("cancelling");
  });
});
