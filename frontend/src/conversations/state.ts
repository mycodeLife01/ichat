import type { ConversationResponse, MessageResponse } from "../api/types";
import type { AppAction } from "../app/store";

export type ConversationIndexState = {
  items: ConversationResponse[];
  selectedId: string | null;
  draftId: string | null;
  pendingTitleIds: string[];
  status: "idle" | "loading" | "loadingMore" | "error";
  hasMore: boolean;
};

export const initialConversationIndexState: ConversationIndexState = {
  items: [],
  selectedId: null,
  draftId: null,
  pendingTitleIds: [],
  status: "idle",
  hasMore: true,
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
  | {
      type: "conversations/listLoaded";
      items: ConversationResponse[];
      hasMore?: boolean;
    }
  | { type: "conversations/listLoadingMore" }
  | {
      type: "conversations/listPageLoaded";
      items: ConversationResponse[];
      hasMore: boolean;
    }
  | { type: "conversations/listError" }
  | { type: "conversations/selected"; id: string | null }
  | { type: "conversations/renamed"; conversation: ConversationResponse }
  | { type: "conversations/removed"; id: string }
  | { type: "conversations/draftCreated"; id: string }
  | { type: "conversations/draftActivated" }
  | { type: "conversations/titlePending"; id: string }
  | { type: "conversations/titleResolved"; id: string };

export function conversationIndexReducer(
  state: ConversationIndexState,
  action: AppAction,
): ConversationIndexState {
  switch (action.type) {
    case "conversations/listLoading":
      return { ...state, status: "loading" };
    case "conversations/listLoaded":
      return {
        ...state,
        items: action.items,
        hasMore: action.hasMore ?? false,
        status: "idle",
      };
    case "conversations/listLoadingMore":
      return { ...state, status: "loadingMore" };
    case "conversations/listPageLoaded": {
      const existingIds = new Set(state.items.map((conversation) => conversation.id));
      const appended = action.items.filter(
        (conversation) => !existingIds.has(conversation.id),
      );
      return {
        ...state,
        items: [...state.items, ...appended],
        hasMore: action.hasMore,
        status: "idle",
      };
    }
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
    case "conversations/draftCreated":
      return { ...state, draftId: action.id };
    case "conversations/draftActivated":
      return { ...state, draftId: null };
    case "conversations/titlePending":
      return state.pendingTitleIds.includes(action.id)
        ? state
        : { ...state, pendingTitleIds: [...state.pendingTitleIds, action.id] };
    case "conversations/titleResolved":
      return {
        ...state,
        pendingTitleIds: state.pendingTitleIds.filter((id) => id !== action.id),
      };
    case "app/reset":
      return initialConversationIndexState;
    default:
      return state;
  }
}

export type ConversationDetailAction =
  | { type: "conversations/detailLoading" }
  | {
      type: "conversations/detailLoaded";
      conversation: ConversationResponse;
      messages: MessageResponse[];
    }
  | { type: "conversations/messageAppended"; message: MessageResponse }
  | { type: "conversations/detailForbidden" }
  | { type: "conversations/detailReset" };

export function conversationDetailReducer(
  state: ConversationDetailState,
  action: AppAction,
): ConversationDetailState {
  switch (action.type) {
    case "conversations/detailLoading":
      return { ...state, status: "loading" };
    case "conversations/detailLoaded":
      return {
        conversation: action.conversation,
        messages: action.messages,
        status: "ready",
      };
    case "conversations/messageAppended":
      return { ...state, messages: [...state.messages, action.message] };
    case "conversations/detailForbidden":
      return { conversation: null, messages: [], status: "forbidden" };
    case "conversations/detailReset":
      return initialConversationDetailState;
    case "conversations/renamed":
      return state.conversation && state.conversation.id === action.conversation.id
        ? { ...state, conversation: action.conversation }
        : state;
    case "app/reset":
      return initialConversationDetailState;
    default:
      return state;
  }
}
