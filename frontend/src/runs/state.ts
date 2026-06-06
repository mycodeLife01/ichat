import type { RunStatus } from "../api/types";
import type { AppAction } from "../app/store";

// AbortController is intentionally NOT stored in the reducer (not serializable).
// useRunStream (later step) keeps it in a ref; only serializable state lives here.
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

export function activeRunReducer(
  state: ActiveRunState,
  action: AppAction,
): ActiveRunState {
  if (action.type === "app/reset") return initialActiveRunState;
  return state;
}
