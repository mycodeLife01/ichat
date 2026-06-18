import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RunStreamEvent } from "../api/types";
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
  const { activeRun, conversationDetail, conversationIndex, ui } = useAppState();
  const { dispatch } = useAppActions();
  return { start, cancel, activeRun, conversationDetail, conversationIndex, ui, dispatch };
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
      await result.current.start("100", conversationResponse.id, 0);
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
      await result.current.start("100", conversationResponse.id, 0);
    });

    expect(detail).toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
    // detailLoaded skipped: detail not applied to the (different) current view.
    expect(result.current.conversationDetail.messages).toEqual([]);
  });

  it("marks the conversation title-pending when it succeeds without a title", async () => {
    const detail = vi.fn(async () => ({ ...conversationResponse, title: null, messages: [] }));
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices(
      {},
      { detail, list },
      { streamEvents: () => fakeStream([{ ...succeededEvent, seq: 1 }]) },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });
    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: conversationResponse.id });
    });
    await act(async () => {
      await result.current.start("100", conversationResponse.id, 0);
    });
    // Empty server title → skeleton until the worker writes one back.
    expect(result.current.conversationIndex.pendingTitleIds).toContain(conversationResponse.id);
  });

  it("does not mark title-pending when the conversation already has a title", async () => {
    const services = createFakeServices(
      {},
      { detail: async () => conversationDetailResponse, list: async () => [conversationResponse] },
      { streamEvents: () => fakeStream([{ ...succeededEvent, seq: 1 }]) },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });
    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: conversationResponse.id });
    });
    await act(async () => {
      await result.current.start("100", conversationResponse.id, 0);
    });
    expect(result.current.conversationIndex.pendingTitleIds).not.toContain(
      conversationResponse.id,
    );
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
      await result.current.start("100", conversationResponse.id, 0);
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
      result.current.dispatch({ type: "run/started", runId: "100", conversationId: "10" });
    });
    await act(async () => {
      await result.current.cancel("100");
    });

    expect(cancel).toHaveBeenCalledWith("100");
    expect(result.current.activeRun?.cancelRequested).toBe(true);
    expect(result.current.activeRun?.status).toBe("cancelling");
  });

  it("ignores repeated cancel calls while one is already pending", async () => {
    // The first cancel request parks unresolved so the second click lands
    // while the run is still "cancelling".
    const cancel = vi.fn(() => new Promise<{ status: string }>(() => {}));
    const services = createFakeServices({}, {}, { cancel });
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: "100", conversationId: "10" });
    });
    await act(async () => {
      void result.current.cancel("100");
      void result.current.cancel("100");
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.current.activeRun?.status).toBe("cancelling");
  });

  it("reverts to streaming when the cancel request fails", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, {}, { cancel });
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: "100", conversationId: "10" });
    });
    await act(async () => {
      await result.current.cancel("100");
    });

    expect(cancel).toHaveBeenCalledWith("100");
    // The stop button recovers so the user can retry.
    expect(result.current.activeRun?.cancelRequested).toBe(false);
    expect(result.current.activeRun?.status).toBe("streaming");
    expect(result.current.ui.toast?.message).toBe("停止失败，请重试");
  });

  it("ignores late deltas once the active run has switched to another conversation", async () => {
    // A controllable stream for run A: first delta lands, then it parks until the
    // test has navigated to another run, then delivers a stale delta.
    let releaseStale: () => void = () => {};
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    async function* leakyStream(): AsyncGenerator<RunStreamEvent> {
      yield { seq: 1, type: "text_delta", data: { ...textDeltaEvent, seq: 1, payload: { text: "AAA" } } };
      await staleGate;
      yield { seq: 2, type: "text_delta", data: { ...textDeltaEvent, seq: 2, payload: { text: "BBB" } } };
    }
    const services = createFakeServices({}, {}, { streamEvents: () => leakyStream() });
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    // Run A active and streaming.
    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: "100", conversationId: "10" });
    });
    let started: Promise<void> = Promise.resolve();
    await act(async () => {
      started = result.current.start("100", "10", 0);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.activeRun?.draftText).toBe("AAA");

    // User navigates to conversation B, whose own (restored) run becomes active.
    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: "200", conversationId: "20" });
    });

    // Run A's late delta arrives — it must NOT append onto run B.
    await act(async () => {
      releaseStale();
      await started;
    });

    expect(result.current.activeRun?.runId).toBe("200");
    expect(result.current.activeRun?.draftText).toBe("");
  });

  it("aborts the previous stream when starting a new one", async () => {
    const signals: AbortSignal[] = [];
    const services = createFakeServices(
      {},
      {},
      {
        streamEvents: (_runId, _afterSeq, options) => {
          if (options?.signal) signals.push(options.signal);
          return fakeStream([]);
        },
      },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.start("100", "10", 0);
    });
    await act(async () => {
      await result.current.start("101", "11", 0);
    });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});
