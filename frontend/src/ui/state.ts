import type { AppAction } from "../app/store";

export type ConfirmDialogState = {
  kind: "deleteConversation";
  conversationId: string;
};

export type ShareDialogState = {
  conversationId: string;
};

export type ToastTone = "neutral" | "success" | "error" | "warning";
export type ToastHandler = (message: string, tone: ToastTone) => void;

// A monotonic id (not the message) keys the Toast component so that triggering
// the same message twice re-mounts and re-animates it.
export type ToastState = {
  id: number;
  message: string;
  tone: ToastTone;
} | null;

export type UiState = {
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  confirmDialog: ConfirmDialogState | null;
  shareDialog: ShareDialogState | null;
  toast: ToastState;
  toastSequence: number;
};

export const initialUiState: UiState = {
  mobileSidebarOpen: false,
  sidebarCollapsed: false,
  confirmDialog: null,
  shareDialog: null,
  toast: null,
  toastSequence: 0,
};

export type UiAction =
  | { type: "ui/toggleMobileSidebar" }
  | { type: "ui/setMobileSidebar"; open: boolean }
  | { type: "ui/toggleSidebarCollapsed" }
  | { type: "ui/openConfirm"; dialog: ConfirmDialogState }
  | { type: "ui/closeConfirm" }
  | { type: "ui/openShare"; dialog: ShareDialogState }
  | { type: "ui/closeShare" }
  | { type: "ui/showToast"; message: string; tone: ToastTone }
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
    case "ui/openShare":
      return { ...state, shareDialog: action.dialog };
    case "ui/closeShare":
      return { ...state, shareDialog: null };
    case "ui/showToast": {
      const id = state.toastSequence + 1;
      return {
        ...state,
        toast: { id, message: action.message, tone: action.tone },
        toastSequence: id,
      };
    }
    case "ui/hideToast":
      return { ...state, toast: null };
    case "app/reset":
      return initialUiState;
    default:
      return state;
  }
}
