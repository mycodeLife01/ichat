import type { RunStatus, RunToolState } from "../api/types";
import type { AppAction } from "../app/store";

export type RunStreamPhase = "waiting" | "reasoning" | "text" | "tool";

// AbortController is intentionally NOT stored in the reducer (not serializable).
// useRunStream registers its abort via streamAbort; only serializable state lives here.
export type ActiveRunState = {
  runId: string;
  conversationId: string;
  providerName: string | null;
  latestSeq: number;
  draftText: string;
  draftReasoning: string;
  draftReasoningSummary: string;
  streamPhase: RunStreamPhase;
  toolState: RunToolState | null;
  status: RunStatus;
  cancelRequested: boolean;
} | null;

export const initialActiveRunState: ActiveRunState = null;

export type ActiveRunAction =
  | {
      type: "run/started";
      runId: string;
      conversationId: string;
      providerName?: string | null;
    }
  | {
      type: "run/restored";
      runId: string;
      conversationId: string;
      providerName?: string | null;
      latestSeq: number;
      draftText: string;
      draftReasoning: string;
      draftReasoningSummary?: string;
      toolState?: RunToolState | null;
      status: RunStatus;
    }
  | {
      type: "run/reasoningDelta";
      seq: number;
      text: string;
      kind?: "raw" | "summary";
    }
  | { type: "run/textDelta"; seq: number; text: string }
  | { type: "run/toolState"; seq: number; toolState: RunToolState }
  | { type: "run/terminal"; status: "succeeded" | "failed" | "cancelled" }
  | { type: "run/cancelRequested" }
  | { type: "run/cancelFailed" }
  | { type: "run/cleared" };

export function activeRunReducer(
  state: ActiveRunState,
  action: AppAction,
): ActiveRunState {
  switch (action.type) {
    case "run/started":
      return {
        runId: action.runId,
        conversationId: action.conversationId,
        providerName: action.providerName ?? null,
        latestSeq: 0,
        draftText: "",
        draftReasoning: "",
        draftReasoningSummary: "",
        streamPhase: "waiting",
        toolState: null,
        status: "started",
        cancelRequested: false,
      };
    case "run/reasoningDelta":
      if (state === null) return state;
      return {
        ...state,
        draftReasoning:
          (action.kind ?? "raw") === "raw"
            ? state.draftReasoning + action.text
            : state.draftReasoning,
        draftReasoningSummary:
          action.kind === "summary"
            ? state.draftReasoningSummary + action.text
            : state.draftReasoningSummary,
        streamPhase: "reasoning",
        toolState: null,
        latestSeq: action.seq,
        // Deltas keep arriving while a cancel is in flight; don't let them
        // flip "cancelling" back to "streaming" (re-enabling the stop button).
        status: state.status === "cancelling" ? state.status : "streaming",
      };
    case "run/textDelta": {
      if (state === null) return state;
      // A provider can emit a leading newline at the reasoning → answer
      // boundary. It is not a visible phase change until actual answer text
      // arrives, so keep the current activity and tool label for whitespace.
      const hasVisibleText = action.text.trim() !== "";
      return {
        ...state,
        draftText: state.draftText + action.text,
        streamPhase: hasVisibleText ? "text" : state.streamPhase,
        toolState: hasVisibleText ? null : state.toolState,
        latestSeq: action.seq,
        status: state.status === "cancelling" ? state.status : "streaming",
      };
    }
    case "run/toolState":
      if (state === null) return state;
      return {
        ...state,
        latestSeq: action.seq,
        streamPhase: "tool",
        // Tool calls may happen after an intermediate text segment. Preserve
        // the current call instead of treating any prior text as final output.
        toolState: action.toolState,
        status: state.status === "cancelling" ? state.status : "streaming",
      };
    case "run/terminal":
      if (state === null) return state;
      return {
        ...state,
        toolState: null,
        status: action.status,
      };
    case "run/restored": {
      const restoredToolState = action.toolState ?? null;
      const hasVisibleText = action.draftText.trim() !== "";
      const keepToolState =
        action.status !== "succeeded" &&
        action.status !== "failed" &&
        action.status !== "cancelled" &&
        restoredToolState !== null &&
        // The state endpoint does not yet expose the latest delta kind. A
        // running call is authoritative even after intermediate text; a
        // completed call is only current when no visible answer has followed.
        (restoredToolState.status === "running" || !hasVisibleText);
      let streamPhase: RunStreamPhase = "waiting";
      if (keepToolState) {
        streamPhase = "tool";
      } else if (hasVisibleText) {
        streamPhase = "text";
      } else if (
        action.draftReasoning.trim() !== "" ||
        (action.draftReasoningSummary ?? "").trim() !== ""
      ) {
        streamPhase = "reasoning";
      }
      return {
        runId: action.runId,
        conversationId: action.conversationId,
        providerName: action.providerName ?? null,
        latestSeq: action.latestSeq,
        draftText: action.draftText,
        draftReasoning: action.draftReasoning,
        draftReasoningSummary: action.draftReasoningSummary ?? "",
        streamPhase,
        toolState: keepToolState ? restoredToolState : null,
        status: action.status,
        cancelRequested: action.status === "cancelling",
      };
    }
    case "run/cancelRequested":
      if (state === null) return state;
      return { ...state, cancelRequested: true, status: "cancelling" };
    case "run/cancelFailed":
      // Only meaningful while the optimistic "stopping" state is showing; a
      // terminal that raced in must not be reverted.
      if (state === null || state.status !== "cancelling") return state;
      return { ...state, cancelRequested: false, status: "streaming" };
    case "run/cleared":
      return null;
    case "app/reset":
      return initialActiveRunState;
    default:
      return state;
  }
}
