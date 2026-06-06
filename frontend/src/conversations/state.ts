import type { ConversationResponse, MessageResponse } from "../api/types";
import type { AppAction } from "../app/store";

export type ConversationIndexState = {
  items: ConversationResponse[];
  selectedId: number | null;
  draftId: number | null;
  pendingTitleIds: number[];
  status: "idle" | "loading" | "error";
};

export const initialConversationIndexState: ConversationIndexState = {
  items: [],
  selectedId: null,
  draftId: null,
  pendingTitleIds: [],
  status: "idle",
};

export type ConversationDetailState = {
  conversation: ConversationResponse | null;
  messages: MessageResponse[];
  status: "idle" | "loading" | "ready" | "forbidden";
};

export const initialConversationDetailState: ConversationDetailState = {
  conversation: null,
  messages: [],
  status: "idle",
};

// Placeholder reducers: only RESET is handled now; feature actions land in later steps.
export function conversationIndexReducer(
  state: ConversationIndexState,
  action: AppAction,
): ConversationIndexState {
  if (action.type === "app/reset") return initialConversationIndexState;
  return state;
}

export function conversationDetailReducer(
  state: ConversationDetailState,
  action: AppAction,
): ConversationDetailState {
  if (action.type === "app/reset") return initialConversationDetailState;
  return state;
}
