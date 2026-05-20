const listeners = new Set();
const SELECTED_KEY = "ichat.selectedId";
const DRAFT_KEY = "ichat.draftConversationId";

const state = {
  conversations: [],            // ConversationResponse[]
  selectedId: null,             // number | null
  draftConversationId: null,    // number | null
  pendingTitleConversationIds: [], // number[]
  detail: null,                 // ConversationDetailResponse | null（选中 conversation 的完整消息）
  activeRun: null,              // { runId, status, controller, draftText, assistantPlaceholderId } | null
  sidebarOpen: false,           // mobile conversation drawer state
};

export function getState() { return state; }

export function setState(patch) {
  Object.assign(state, patch);
  if (Object.prototype.hasOwnProperty.call(patch, "selectedId")) {
    persistNumber(SELECTED_KEY, patch.selectedId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "draftConversationId")) {
    persistNumber(DRAFT_KEY, patch.draftConversationId);
  }
  for (const l of listeners) l(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readStoredConversationIds() {
  return {
    selectedId: readNumber(SELECTED_KEY),
    draftConversationId: readNumber(DRAFT_KEY),
  };
}

export function clearStoredConversationSelection() {
  const store = storage();
  if (!store) return;
  store.removeItem(SELECTED_KEY);
  store.removeItem(DRAFT_KEY);
}

// Hard reset the in-memory state singleton. Used when the auth identity
// changes (logout, refresh-token failure) so the next user starts clean and
// cannot inherit the previous user's conversation or streaming output. Any
// active SSE run is aborted so its callbacks stop writing into state.
export function resetState() {
  if (state.activeRun?.controller) {
    try { state.activeRun.controller.abort(); } catch {}
  }
  state.conversations = [];
  state.selectedId = null;
  state.draftConversationId = null;
  state.pendingTitleConversationIds = [];
  state.detail = null;
  state.activeRun = null;
  state.sidebarOpen = false;
  clearStoredConversationSelection();
  for (const l of listeners) l(state);
}

function persistNumber(key, value) {
  const store = storage();
  if (!store) return;
  if (typeof value === "number" && Number.isFinite(value)) {
    store.setItem(key, String(value));
  } else {
    store.removeItem(key);
  }
}

function readNumber(key) {
  const store = storage();
  if (!store) return null;
  const value = Number(store.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function storage() {
  return globalThis.localStorage ?? null;
}
