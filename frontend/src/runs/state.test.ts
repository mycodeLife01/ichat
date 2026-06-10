import { describe, expect, it } from "vitest";

import { activeRunReducer, initialActiveRunState, type ActiveRunState } from "./state";

const started: ActiveRunState = {
  runId: 100,
  conversationId: 10,
  latestSeq: 0,
  draftText: "",
  draftReasoning: "",
  status: "started",
  cancelRequested: false,
};

describe("activeRunReducer", () => {
  it("starts a run from null", () => {
    const next = activeRunReducer(null, {
      type: "run/started",
      runId: 100,
      conversationId: 10,
    });
    expect(next).toEqual(started);
  });

  it("accumulates reasoning deltas", () => {
    const a = activeRunReducer(started, { type: "run/reasoningDelta", seq: 1, text: "想" });
    const b = activeRunReducer(a, { type: "run/reasoningDelta", seq: 2, text: "法" });
    expect(b?.draftReasoning).toBe("想法");
    expect(b?.latestSeq).toBe(2);
    expect(b?.status).toBe("streaming");
  });

  it("accumulates text deltas", () => {
    const a = activeRunReducer(started, { type: "run/textDelta", seq: 3, text: "Hel" });
    const b = activeRunReducer(a, { type: "run/textDelta", seq: 4, text: "lo" });
    expect(b?.draftText).toBe("Hello");
    expect(b?.latestSeq).toBe(4);
    expect(b?.status).toBe("streaming");
  });

  it("sets terminal status but keeps drafts", () => {
    const streaming = activeRunReducer(started, { type: "run/textDelta", seq: 1, text: "x" });
    const failed = activeRunReducer(streaming, { type: "run/terminal", status: "failed" });
    expect(failed?.status).toBe("failed");
    expect(failed?.draftText).toBe("x");
  });

  it("marks cancel requested", () => {
    const next = activeRunReducer(started, { type: "run/cancelRequested" });
    expect(next?.cancelRequested).toBe(true);
    expect(next?.status).toBe("cancelling");
  });

  it("keeps cancelling status while deltas continue to arrive", () => {
    // The server keeps streaming until the cancel lands; in-flight deltas must
    // still render but must not flip the run back to "streaming" (which would
    // re-enable the stop button mid-cancel).
    const cancelling = activeRunReducer(started, { type: "run/cancelRequested" });
    const afterReasoning = activeRunReducer(cancelling, {
      type: "run/reasoningDelta", seq: 1, text: "想",
    });
    expect(afterReasoning?.status).toBe("cancelling");
    expect(afterReasoning?.draftReasoning).toBe("想");
    const afterText = activeRunReducer(afterReasoning, {
      type: "run/textDelta", seq: 2, text: "Hel",
    });
    expect(afterText?.status).toBe("cancelling");
    expect(afterText?.draftText).toBe("Hel");
  });

  it("clears to null", () => {
    expect(activeRunReducer(started, { type: "run/cleared" })).toBeNull();
  });

  it("resets on app/reset", () => {
    expect(activeRunReducer(started, { type: "app/reset" })).toBe(initialActiveRunState);
  });

  it("ignores actions when state is null", () => {
    expect(activeRunReducer(null, { type: "run/textDelta", seq: 1, text: "x" })).toBeNull();
    expect(activeRunReducer(null, { type: "run/terminal", status: "failed" })).toBeNull();
    expect(activeRunReducer(null, { type: "run/cancelRequested" })).toBeNull();
  });

  it("restores a run from server state", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: 100,
      conversationId: 10,
      latestSeq: 5,
      draftText: "Hel",
      draftReasoning: "想",
      status: "streaming",
    });
    expect(next).toEqual({
      runId: 100,
      conversationId: 10,
      latestSeq: 5,
      draftText: "Hel",
      draftReasoning: "想",
      status: "streaming",
      cancelRequested: false,
    });
  });

  it("marks cancelRequested when restoring a cancelling run", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: 100,
      conversationId: 10,
      latestSeq: 5,
      draftText: "",
      draftReasoning: "",
      status: "cancelling",
    });
    expect(next?.cancelRequested).toBe(true);
  });

  it("reverts cancelling to streaming on cancelFailed", () => {
    const cancelling = activeRunReducer(started, { type: "run/cancelRequested" });
    const next = activeRunReducer(cancelling, { type: "run/cancelFailed" });
    expect(next?.status).toBe("streaming");
    expect(next?.cancelRequested).toBe(false);
  });

  it("ignores cancelFailed when not cancelling", () => {
    const cancelled = activeRunReducer(started, { type: "run/terminal", status: "cancelled" });
    expect(activeRunReducer(cancelled, { type: "run/cancelFailed" })).toBe(cancelled);
    expect(activeRunReducer(null, { type: "run/cancelFailed" })).toBeNull();
  });
});
