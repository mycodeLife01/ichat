import type { AppAction } from "../app/store";

export type ConfirmDialogState = {
  kind: "deleteConversation";
  conversationId: string;
};

// A monotonic id (not the message) keys the Toast component so that triggering
// the same message twice re-mounts and re-animates it.
export type ToastState = {
  id: number;
  message: string;
} | null;

export type UiState = {
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  confirmDialog: ConfirmDialogState | null;
  toast: ToastState;
};

export const initialUiState: UiState = {
  mobileSidebarOpen: false,
  sidebarCollapsed: false,
  confirmDialog: null,
  toast: null,
};

export type UiAction =
  | { type: "ui/toggleMobileSidebar" }
  | { type: "ui/setMobileSidebar"; open: boolean }
  | { type: "ui/toggleSidebarCollapsed" }
  | { type: "ui/openConfirm"; dialog: ConfirmDialogState }
  | { type: "ui/closeConfirm" }
  | { type: "ui/showToast"; message: string }
  | { type: "ui/hideToast" };

export function uiReducer(state: UiState, action: AppAction): UiState {
  switch (action.type) {
    case "ui/toggleMobileSidebar":
      return { ...state, mobileSidebarOpen: !state.mobileSidebarOpen };
    case "ui/setMobileSidebar":
      return { ...state, mobileSidebarOpen: action.open };
    case "ui/toggleSidebarCollapsed":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "ui/openConfirm":
      return { ...state, confirmDialog: action.dialog };
    case "ui/closeConfirm":
      return { ...state, confirmDialog: null };
    case "ui/showToast":
      return { ...state, toast: { id: (state.toast?.id ?? 0) + 1, message: action.message } };
    case "ui/hideToast":
      return { ...state, toast: null };
    case "app/reset":
      return initialUiState;
    default:
      return state;
  }
}
