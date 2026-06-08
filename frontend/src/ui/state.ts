import type { AppAction } from "../app/store";

export type ConfirmDialogState = {
  kind: "deleteConversation";
  conversationId: number;
};

export type UiState = {
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  confirmDialog: ConfirmDialogState | null;
};

export const initialUiState: UiState = {
  mobileSidebarOpen: false,
  sidebarCollapsed: false,
  confirmDialog: null,
};

export type UiAction =
  | { type: "ui/toggleMobileSidebar" }
  | { type: "ui/setMobileSidebar"; open: boolean }
  | { type: "ui/toggleSidebarCollapsed" }
  | { type: "ui/openConfirm"; dialog: ConfirmDialogState }
  | { type: "ui/closeConfirm" };

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
    case "app/reset":
      return initialUiState;
    default:
      return state;
  }
}
