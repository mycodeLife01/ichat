import type { AppAction } from "../app/store";

export type PendingSubmissionState = {
  content: string;
  conversationId: string | null;
} | null;

export const initialPendingSubmissionState: PendingSubmissionState = null;

export type PendingSubmissionAction =
  | {
      type: "submission/started";
      content: string;
      conversationId: string | null;
    }
  | { type: "submission/targeted"; conversationId: string }
  | { type: "submission/cleared" };

export function pendingSubmissionReducer(
  state: PendingSubmissionState,
  action: AppAction,
): PendingSubmissionState {
  switch (action.type) {
    case "submission/started":
      return {
        content: action.content,
        conversationId: action.conversationId,
      };
    case "submission/targeted":
      return state === null ? state : { ...state, conversationId: action.conversationId };
    case "submission/cleared":
    case "app/reset":
      return initialPendingSubmissionState;
    default:
      return state;
  }
}
