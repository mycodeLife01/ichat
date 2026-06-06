import { createContext, useContext, type Dispatch } from "react";

import type { LoginRequest, RegisterRequest } from "../api/auth";
import type { AuthTokenResponse, CommandStatusResponse } from "../api/types";
import type { AppAction, AppState } from "./store";

export type AuthApi = {
  register(body: RegisterRequest): Promise<AuthTokenResponse>;
  login(body: LoginRequest): Promise<AuthTokenResponse>;
  refresh(refreshToken: string): Promise<AuthTokenResponse>;
  logout(refreshToken: string): Promise<CommandStatusResponse>;
};

export type Services = {
  authApi: AuthApi;
};

// Lets useRunStream (later step) register its abort, and lets logout / auth
// expiry abort the in-flight stream without knowing about it directly.
export type StreamAbortController = {
  register(abort: () => void): void;
  abort(): void;
};

export type AppActions = {
  dispatch: Dispatch<AppAction>;
  services: Services;
  streamAbort: StreamAbortController;
};

export const StateContext = createContext<AppState | null>(null);
export const ActionsContext = createContext<AppActions | null>(null);

export function useAppState(): AppState {
  const value = useContext(StateContext);
  if (value === null) {
    throw new Error("useAppState must be used within AppProvider");
  }
  return value;
}

export function useAppActions(): AppActions {
  const value = useContext(ActionsContext);
  if (value === null) {
    throw new Error("useAppActions must be used within AppProvider");
  }
  return value;
}
