import {
  conversationDetailReducer,
  conversationIndexReducer,
  initialConversationDetailState,
  initialConversationIndexState,
  type ConversationDetailAction,
  type ConversationDetailState,
  type ConversationIndexAction,
  type ConversationIndexState,
} from "../conversations/state";
import { authReducer, initialAuthState, type AuthAction, type AuthState } from "../auth/state";
import { activeRunReducer, initialActiveRunState, type ActiveRunState } from "../runs/state";
import { initialUiState, uiReducer, type UiAction, type UiState } from "../ui/state";

export type ComposerState = { input: string; isComposing: boolean };

const initialComposerState: ComposerState = { input: "", isComposing: false };

export type AppState = {
  auth: AuthState;
  conversationIndex: ConversationIndexState;
  conversationDetail: ConversationDetailState;
  activeRun: ActiveRunState;
  composer: ComposerState;
  ui: UiState;
};

export type AppResetAction = { type: "app/reset" };
export type AppAction =
  | AuthAction
  | ConversationIndexAction
  | ConversationDetailAction
  | UiAction
  | AppResetAction;

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
