import type { AppAction } from "../app/store";
import type { FileAttachment } from "../files/types";

export type PendingSubmissionState = {
  clientId: string;
  content: string;
  conversationId: string | null;
  attachments: FileAttachment[];
} | null;

export const initialPendingSubmissionState: PendingSubmissionState = null;

export type PendingSubmissionAction =
  | {
      type: "submission/started";
      clientId: string;
      content: string;
      conversationId: string | null;
      attachments: FileAttachment[];
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
        clientId: action.clientId,
        content: action.content,
        conversationId: action.conversationId,
        attachments: action.attachments,
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
