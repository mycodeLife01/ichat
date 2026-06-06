import type { AppAction } from "../app/store";
import type { AuthSession } from "./tokenStore";

export type AuthState = {
  session: AuthSession | null;
  status: "idle" | "submitting";
  bootstrapped: boolean;
};

export const initialAuthState: AuthState = {
  session: null,
  status: "idle",
  bootstrapped: false,
};

export type AuthAction =
  | { type: "auth/restored"; session: AuthSession | null }
  | { type: "auth/submitStarted" }
  | { type: "auth/loggedIn"; session: AuthSession }
  | { type: "auth/submitFailed" };

export function authReducer(state: AuthState, action: AppAction): AuthState {
  switch (action.type) {
    case "auth/restored":
      return { ...state, session: action.session, bootstrapped: true };
    case "auth/submitStarted":
      return { ...state, status: "submitting" };
    case "auth/loggedIn":
      return { ...state, session: action.session, status: "idle" };
    case "auth/submitFailed":
      return { ...state, status: "idle" };
    case "app/reset":
      return { ...initialAuthState, bootstrapped: true };
    default:
      return state;
  }
}
