import {
  conversationDetailReducer,
  conversationIndexReducer,
  initialConversationDetailState,
  initialConversationIndexState,
  type ConversationDetailState,
  type ConversationIndexAction,
  type ConversationIndexState,
} from "../conversations/state";
import { authReducer, initialAuthState, type AuthAction, type AuthState } from "../auth/state";
import { activeRunReducer, initialActiveRunState, type ActiveRunState } from "../runs/state";

export type ComposerState = { input: string; isComposing: boolean };
export type UiState = { mobileSidebarOpen: boolean };

const initialComposerState: ComposerState = { input: "", isComposing: false };
const initialUiState: UiState = { mobileSidebarOpen: false };

export type AppState = {
  auth: AuthState;
  conversationIndex: ConversationIndexState;
  conversationDetail: ConversationDetailState;
  activeRun: ActiveRunState;
  composer: ComposerState;
  ui: UiState;
};

export type AppResetAction = { type: "app/reset" };
export type AppAction = AuthAction | ConversationIndexAction | AppResetAction;

export const initialState: AppState = {
  auth: initialAuthState,
  conversationIndex: initialConversationIndexState,
  conversationDetail: initialConversationDetailState,
  activeRun: initialActiveRunState,
  composer: initialComposerState,
  ui: initialUiState,
};

function composerReducer(state: ComposerState, action: AppAction): ComposerState {
  if (action.type === "app/reset") return initialComposerState;
  return state;
}

function uiReducer(state: UiState, action: AppAction): UiState {
  if (action.type === "app/reset") return initialUiState;
  return state;
}

export function rootReducer(state: AppState, action: AppAction): AppState {
  return {
    auth: authReducer(state.auth, action),
    conversationIndex: conversationIndexReducer(state.conversationIndex, action),
    conversationDetail: conversationDetailReducer(state.conversationDetail, action),
    activeRun: activeRunReducer(state.activeRun, action),
    composer: composerReducer(state.composer, action),
    ui: uiReducer(state.ui, action),
  };
}
