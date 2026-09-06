import type { RunStatus, RunToolState } from "../api/types";


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
