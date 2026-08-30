import { describe, expect, it } from "vitest";

import { activeRunReducer, initialActiveRunState, type ActiveRunState } from "./state";

const started: ActiveRunState = {
  runId: "100",
  conversationId: "10",
  providerName: null,
  latestSeq: 0,
  draftText: "",
  draftReasoning: "",
  draftReasoningSummary: "",
  streamPhase: "waiting",
  toolState: null,
  status: "started",
  cancelRequested: false,
};

describe("activeRunReducer", () => {
  it("starts a run from null", () => {
    const next = activeRunReducer(null, {
      type: "run/started",
      runId: "100",
      conversationId: "10",
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

  it("accumulates raw reasoning and reasoning summaries independently", () => {
    const raw = activeRunReducer(started, {
      type: "run/reasoningDelta", seq: 1, text: "完整过程", kind: "raw",
    });
    const summary = activeRunReducer(raw, {
      type: "run/reasoningDelta", seq: 2, text: "简短摘要", kind: "summary",
    });
    expect(summary?.draftReasoning).toBe("完整过程");
    expect(summary?.draftReasoningSummary).toBe("简短摘要");
  });

  it("accumulates text deltas", () => {
    const a = activeRunReducer(started, { type: "run/textDelta", seq: 3, text: "Hel" });
    const b = activeRunReducer(a, { type: "run/textDelta", seq: 4, text: "lo" });
    expect(b?.draftText).toBe("Hello");
    expect(b?.latestSeq).toBe(4);
    expect(b?.status).toBe("streaming");
  });

  it("tracks reasoning, text, tool, and resumed reasoning as distinct stream phases", () => {
    const reasoning = activeRunReducer(started, {
      type: "run/reasoningDelta",
      seq: 1,
      text: "先分析",
      kind: "summary",
    });
    expect(reasoning?.streamPhase).toBe("reasoning");

    const text = activeRunReducer(reasoning, {
      type: "run/textDelta",
      seq: 2,
      text: "先搜索一下。",
    });
    expect(text?.streamPhase).toBe("text");

    const tool = activeRunReducer(text, {
      type: "run/toolState",
      seq: 3,
      toolState: {
        status: "running",
        tool_name: "web_search",
        query: "奥数图论题",
        message: null,
        result_count: null,
        sources: [],
      },
    });
    expect(tool?.streamPhase).toBe("tool");
    expect(tool?.toolState?.status).toBe("running");

    const resumedReasoning = activeRunReducer(tool, {
      type: "run/reasoningDelta",
      seq: 4,
      text: "继续分析",
      kind: "summary",
    });
    expect(resumedReasoning?.streamPhase).toBe("reasoning");
    expect(resumedReasoning?.toolState).toBeNull();
  });

  it("keeps reasoning but clears tool state when the formal answer starts", () => {
    const reasoning = activeRunReducer(started, {
      type: "run/reasoningDelta", seq: 1, text: "想法",
    });
    const withTool = activeRunReducer(reasoning, {
      type: "run/toolState",
      seq: 2,
      toolState: {
        status: "running",
        tool_name: "web_search",
        query: "query",
        message: null,
        result_count: null,
        sources: [],
      },
    });
    const next = activeRunReducer(withTool, {
      type: "run/textDelta", seq: 3, text: "正文",
    });
    expect(next?.draftText).toBe("正文");
    expect(next?.draftReasoning).toBe("想法");
    expect(next?.toolState).toBeNull();
  });

  it("sets terminal status and keeps both the formal draft and reasoning", () => {
    const reasoning = activeRunReducer(started, {
      type: "run/reasoningDelta", seq: 1, text: "想法",
    });
    const streaming = activeRunReducer(reasoning, {
      type: "run/textDelta", seq: 2, text: "x",
    });
    const failed = activeRunReducer(streaming, { type: "run/terminal", status: "failed" });
    expect(failed?.status).toBe("failed");
    expect(failed?.draftText).toBe("x");
    expect(failed?.draftReasoning).toBe("想法");
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

  it("restores raw reasoning and summary even when a formal draft exists", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: "100",
      conversationId: "10",
      providerName: null,
      latestSeq: 5,
      draftText: "Hel",
      draftReasoning: "想",
      draftReasoningSummary: "摘要",
      status: "streaming",
    });
    expect(next).toEqual({
      runId: "100",
      conversationId: "10",
      providerName: null,
      latestSeq: 5,
      draftText: "Hel",
      draftReasoning: "想",
      draftReasoningSummary: "摘要",
      streamPhase: "text",
      toolState: null,
      status: "streaming",
      cancelRequested: false,
    });
  });

  it("restores active reasoning when no formal answer exists yet", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: "100",
      conversationId: "10",
      latestSeq: 5,
      draftText: "",
      draftReasoning: "想",
      status: "streaming",
    });
    expect(next?.draftReasoning).toBe("想");
  });

  it("restores a running tool even after intermediate text", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: "100",
      conversationId: "10",
      latestSeq: 5,
      draftText: "先搜索一下。",
      draftReasoning: "先分析",
      toolState: {
        status: "running",
        tool_name: "web_search",
        query: "奥数图论题",
        message: null,
        result_count: null,
        sources: [],
      },
      status: "streaming",
    });

    expect(next?.streamPhase).toBe("tool");
    expect(next?.toolState?.status).toBe("running");
  });

  it("does not restore a completed tool over visible text without a current phase", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: "100",
      conversationId: "10",
      latestSeq: 5,
      draftText: "部分正文",
      draftReasoning: "先分析",
      toolState: {
        status: "succeeded",
        tool_name: "web_search",
        query: "奥数图论题",
        message: null,
        result_count: 3,
        sources: [],
      },
      status: "streaming",
    });

    expect(next?.streamPhase).toBe("text");
    expect(next?.toolState).toBeNull();
  });

  it("marks cancelRequested when restoring a cancelling run", () => {
    const next = activeRunReducer(null, {
      type: "run/restored",
      runId: "100",
      conversationId: "10",
      latestSeq: 5,
      draftText: "",
      draftReasoning: "",
      toolState: null,
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
