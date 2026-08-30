import type { RunStatus, RunToolState } from "../api/types";
import type { AppAction } from "../app/store";

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
        toolState: null,
        latestSeq: action.seq,
        status: state.status === "cancelling" ? state.status : "streaming",
      };
    case "run/toolState":
      if (state === null) return state;
      return {
        ...state,
        latestSeq: action.seq,
        toolState: state.draftText === "" ? (action.toolState ?? null) : null,
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
      const keepToolState =
        action.draftText === "" &&
        action.status !== "succeeded" &&
        action.status !== "failed" &&
        action.status !== "cancelled";
      return {
        runId: action.runId,
        conversationId: action.conversationId,
        providerName: action.providerName ?? null,
        latestSeq: action.latestSeq,
        draftText: action.draftText,
        draftReasoning: action.draftReasoning,
        draftReasoningSummary: action.draftReasoningSummary ?? "",
        toolState: keepToolState ? (action.toolState ?? null) : null,
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
