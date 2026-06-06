import type { Dispatch } from "react";

import type { AppAction } from "./store";

export type AuthExpiryDeps = {
  dispatch: Dispatch<AppAction>;
  abort: () => void;
};

// Wired into ApiClient.onAuthExpired by AppProvider: when a refresh fails,
// abort any in-flight stream and reset all private state.
export function createAuthExpiryHandler(deps: AuthExpiryDeps): () => void {
  return () => {
    deps.abort();
    deps.dispatch({ type: "app/reset" });
  };
}
