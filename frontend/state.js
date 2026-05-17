const listeners = new Set();
const state = {
  conversations: [],            // ConversationResponse[]
  selectedId: null,             // number | null
  detail: null,                 // ConversationDetailResponse | null（选中 conversation 的完整消息）
  activeRun: null,              // { runId, status, controller, draftText, assistantPlaceholderId } | null
  sidebarOpen: false,           // mobile conversation drawer state
};

export function getState() { return state; }

export function setState(patch) {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
