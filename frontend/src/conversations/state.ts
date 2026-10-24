import type {
  ConversationActiveRun,
  ConversationResponse,
  ImageContext,
  MessageResponse,
} from "../api/types";
import type { AppAction } from "../app/store";

export type ConversationIndexState = {
  items: ConversationResponse[];
  selectedId: string | null;
  draftId: string | null;
  pendingTitleIds: string[];
  // Conversations whose run finished while the user was elsewhere; cleared on entry.
  unreadIds: string[];
  status: "idle" | "loading" | "loadingMore" | "error";
  hasMore: boolean;
};

export const initialConversationIndexState: ConversationIndexState = {
  items: [],
  selectedId: null,
  draftId: null,
  pendingTitleIds: [],
  unreadIds: [],
  // The bootstrap list fetch starts on mount, so the index begins loading
  // rather than flashing the empty-history state first.
  status: "loading",
  hasMore: true,
};

export type ConversationDetailState = {
  conversation: ConversationResponse | null;
  messages: MessageResponse[];
  imageContext: ImageContext;
  status: "idle" | "loading" | "ready" | "forbidden";
};

export const initialConversationDetailState: ConversationDetailState = {
  conversation: null,
  messages: [],
  imageContext: { state: "none", legacy_message_id: null },
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
  // Refreshed first page merged over the current list (polling / post-run sync).
  | { type: "conversations/listSynced"; items: ConversationResponse[] }
  | {
      type: "conversations/runStarted";
      conversation: ConversationResponse;
      run: ConversationActiveRun;
      updatedAt: string;
    }
  | { type: "conversations/runFinished"; id: string }
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
      return reconcileList(state, {
        ...state,
        items: action.items,
        hasMore: action.hasMore ?? false,
        status: "idle",
      });
    case "conversations/listSynced":
      return reconcileList(state, { ...state, items: mergeFirstPage(state.items, action.items) });
    case "conversations/runStarted": {
      const existing = state.items.find((c) => c.id === action.conversation.id);
      const started: ConversationResponse = {
        ...(existing ?? action.conversation),
        active_run: action.run,
        updated_at: action.updatedAt,
      };
      const needsTitle =
        !started.title?.trim() && !state.pendingTitleIds.includes(started.id);
      return {
        ...state,
        items: [started, ...state.items.filter((c) => c.id !== started.id)],
        pendingTitleIds: needsTitle
          ? [...state.pendingTitleIds, started.id]
          : state.pendingTitleIds,
      };
    }
    case "conversations/runFinished": {
      const finished = state.items.map((c) =>
        c.id === action.id && c.active_run ? { ...c, active_run: null } : c,
      );
      return {
        ...state,
        items: finished,
        unreadIds: markUnread(state.unreadIds, action.id, state.selectedId),
      };
    }
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
      return {
        ...state,
        selectedId: action.id,
        unreadIds: state.unreadIds.filter((id) => id !== action.id),
      };
    case "conversations/renamed":
      return {
        ...state,
        items: state.items.map((c) =>
          c.id === action.conversation.id
            ? { ...action.conversation, active_run: c.active_run }
            : c,
        ),
      };
    case "conversations/removed":
      return {
        ...state,
        items: state.items.filter((c) => c.id !== action.id),
        unreadIds: state.unreadIds.filter((id) => id !== action.id),
      };
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

function markUnread(unreadIds: string[], id: string, selectedId: string | null): string[] {
  return id === selectedId || unreadIds.includes(id) ? unreadIds : [...unreadIds, id];
}

// Server rows replace local ones unless the local row is newer (e.g. a poll
// issued before a send landed after it). Rows beyond the first page are kept.
function mergeFirstPage(
  current: ConversationResponse[],
  page: ConversationResponse[],
): ConversationResponse[] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const pageIds = new Set(page.map((c) => c.id));
  const merged = page.map((incoming) => {
    const local = byId.get(incoming.id);
    return local && Date.parse(incoming.updated_at) < Date.parse(local.updated_at)
      ? local
      : incoming;
  });
  return [...merged, ...current.filter((c) => !pageIds.has(c.id))];
}

// A run seen in flight that is now gone finished in the background: mark it
// unread unless it is open. A pending title that has landed stops pending.
function reconcileList(
  prev: ConversationIndexState,
  next: ConversationIndexState,
): ConversationIndexState {
  const prevById = new Map(prev.items.map((c) => [c.id, c]));
  let unreadIds = next.unreadIds;
  for (const item of next.items) {
    if (prevById.get(item.id)?.active_run && !item.active_run) {
      unreadIds = markUnread(unreadIds, item.id, next.selectedId);
    }
  }
  const titled = new Set(next.items.filter((c) => c.title?.trim()).map((c) => c.id));
  const pendingTitleIds = next.pendingTitleIds.filter((id) => !titled.has(id));
  return {
    ...next,
    unreadIds,
    pendingTitleIds:
      pendingTitleIds.length === next.pendingTitleIds.length
        ? next.pendingTitleIds
        : pendingTitleIds,
  };
}

export type ConversationDetailAction =
  | { type: "conversations/detailLoading" }
  | {
      type: "conversations/detailLoaded";
      conversation: ConversationResponse;
      messages: MessageResponse[];
      imageContext?: ImageContext;
    }
  | {
      type: "conversations/messageAppended";
      message: MessageResponse;
      imageContext?: ImageContext;
    }
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
        imageContext: action.imageContext ?? { state: "none", legacy_message_id: null },
        status: "ready",
      };
    case "conversations/messageAppended":
      return {
        ...state,
        messages: [...state.messages, action.message],
        imageContext: action.imageContext ?? state.imageContext,
      };
    case "conversations/detailForbidden":
      return {
        conversation: null,
        messages: [],
        imageContext: { state: "none", legacy_message_id: null },
        status: "forbidden",
      };
    case "conversations/detailReset":
      return initialConversationDetailState;
    case "conversations/renamed":
      return state.conversation && state.conversation.id === action.conversation.id
        ? { ...state, conversation: action.conversation }
        : state;
    case "conversations/listLoaded":
    case "conversations/listSynced": {
      // The topbar reads detail, so a title that landed in the list syncs here.
      const current = state.conversation;
      const synced = current && action.items.find((c) => c.id === current.id);
      return synced &&
        synced.title !== current.title &&
        Date.parse(synced.updated_at) >= Date.parse(current.updated_at)
        ? { ...state, conversation: { ...current, title: synced.title } }
        : state;
    }
    case "app/reset":
      return initialConversationDetailState;
    default:
      return state;
  }
}
