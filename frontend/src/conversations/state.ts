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

export type ConversationIndexAction =
  | { type: "conversations/listLoading" }
  | { type: "conversations/listLoaded"; items: ConversationResponse[] }
  | { type: "conversations/listError" }
  | { type: "conversations/selected"; id: number | null }
  | { type: "conversations/renamed"; conversation: ConversationResponse }
  | { type: "conversations/removed"; id: number };

export function conversationIndexReducer(
  state: ConversationIndexState,
  action: AppAction,
): ConversationIndexState {
  switch (action.type) {
    case "conversations/listLoading":
      return { ...state, status: "loading" };
    case "conversations/listLoaded":
      return { ...state, items: action.items, status: "idle" };
    case "conversations/listError":
      return { ...state, status: "error" };
    case "conversations/selected":
      return { ...state, selectedId: action.id };
    case "conversations/renamed":
      return {
        ...state,
        items: state.items.map((c) =>
          c.id === action.conversation.id ? action.conversation : c,
        ),
      };
    case "conversations/removed":
      return { ...state, items: state.items.filter((c) => c.id !== action.id) };
    case "app/reset":
      return initialConversationIndexState;
    default:
      return state;
  }
}

export function conversationDetailReducer(
  state: ConversationDetailState,
  action: AppAction,
): ConversationDetailState {
  if (action.type === "app/reset") return initialConversationDetailState;
  return state;
}
