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
  | { type: "run/reasoningDelta"; seq: number; text: string }
  | { type: "run/textDelta"; seq: number; text: string }
  | { type: "run/terminal"; status: "succeeded" | "failed" | "cancelled" }
  | { type: "run/cancelRequested" }
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
        status: "streaming",
      };
    case "run/textDelta":
      if (state === null) return state;
      return {
        ...state,
        draftText: state.draftText + action.text,
        latestSeq: action.seq,
        status: "streaming",
      };
    case "run/terminal":
      if (state === null) return state;
      return { ...state, status: action.status };
    case "run/cancelRequested":
      if (state === null) return state;
      return { ...state, cancelRequested: true, status: "cancelling" };
    case "run/cleared":
      return null;
    case "app/reset":
      return initialActiveRunState;
    default:
      return state;
  }
}
