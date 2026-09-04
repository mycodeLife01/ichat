import type { AppAction } from "../app/store";
import type { FileAttachment } from "../files/types";
import type { ReplyQuoteDraft } from "../api/types";

export type PendingSubmissionState = {
  clientId: string;
  content: string;
  conversationId: string | null;
  attachments: FileAttachment[];
  replyQuote: ReplyQuoteDraft | null;
} | null;

export const initialPendingSubmissionState: PendingSubmissionState = null;

export type PendingSubmissionAction =
  | {
      type: "submission/started";
      clientId: string;
      content: string;
      conversationId: string | null;
      attachments: FileAttachment[];
      replyQuote: ReplyQuoteDraft | null;
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
        replyQuote: action.replyQuote,
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
