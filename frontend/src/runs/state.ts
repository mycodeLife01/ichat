import type { RunStatus } from "../api/types";
import type { AppAction } from "../app/store";

// AbortController is intentionally NOT stored in the reducer (not serializable).
// useRunStream registers its abort via streamAbort; only serializable state lives here.
export type ActiveRunState = {
  runId: number;
  conversationId: number;
  latestSeq: number;
  draftText: string;
  draftReasoning: string;
  status: RunStatus;
  cancelRequested: boolean;
} | null;

export const initialActiveRunState: ActiveRunState = null;

export type ActiveRunAction =
  | { type: "run/started"; runId: number; conversationId: number }
  | {
      type: "run/restored";
      runId: number;
      conversationId: number;
      latestSeq: number;
      draftText: string;
      draftReasoning: string;
      status: RunStatus;
    }
  | { type: "run/reasoningDelta"; seq: number; text: string }
  | { type: "run/textDelta"; seq: number; text: string }
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
        latestSeq: 0,
        draftText: "",
        draftReasoning: "",
        status: "started",
        cancelRequested: false,
      };
    case "run/reasoningDelta":
      if (state === null) return state;
      return {
        ...state,
        draftReasoning: state.draftReasoning + action.text,
        latestSeq: action.seq,
        // Deltas keep arriving while a cancel is in flight; don't let them
        // flip "cancelling" back to "streaming" (re-enabling the stop button).
        status: state.status === "cancelling" ? state.status : "streaming",
      };
    case "run/textDelta":
      if (state === null) return state;
      return {
        ...state,
        draftText: state.draftText + action.text,
        latestSeq: action.seq,
        status: state.status === "cancelling" ? state.status : "streaming",
      };
    case "run/terminal":
      if (state === null) return state;
      return { ...state, status: action.status };
    case "run/restored":
      return {
        runId: action.runId,
        conversationId: action.conversationId,
        latestSeq: action.latestSeq,
        draftText: action.draftText,
        draftReasoning: action.draftReasoning,
        status: action.status,
        cancelRequested: action.status === "cancelling",
      };
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
