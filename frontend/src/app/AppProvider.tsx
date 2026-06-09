import { useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { createAuthApi } from "../api/auth";
import { ApiClient } from "../api/client";
import { createConversationApi } from "../api/conversations";
import { createRunApi } from "../api/runs";
import { tokenStore } from "../auth/tokenStore";
import { createAuthExpiryHandler } from "./authExpiry";
import {
  ActionsContext,
  StateContext,
  type AppActions,
  type Services,
  type StreamAbortController,
} from "./context";
import { initialState, rootReducer } from "./store";

type AppProviderProps = {
  children: ReactNode;
  /** Test seam: inject fake services to bypass the real HTTP client. */
  services?: Services;
};

export function AppProvider({ children, services: injectedServices }: AppProviderProps) {
  const [state, dispatch] = useReducer(rootReducer, initialState);

  const abortRef = useRef<() => void>(() => {});
  const streamAbort = useMemo<StreamAbortController>(
    () => ({
      register(abort) {
        abortRef.current = abort;
      },
      abort() {
        abortRef.current();
      },
    }),
    [],
  );

  const services = useMemo<Services>(() => {
    if (injectedServices) return injectedServices;
    const client = new ApiClient({
      onAuthExpired: createAuthExpiryHandler({ dispatch, abort: streamAbort.abort }),
    });
    return {
      authApi: createAuthApi(client),
      conversationApi: createConversationApi(client),
      runApi: createRunApi(client),
    };
  }, [injectedServices, dispatch, streamAbort]);

  const actions = useMemo<AppActions>(
    () => ({ dispatch, services, streamAbort }),
    [dispatch, services, streamAbort],
  );

  useEffect(() => {
    dispatch({ type: "auth/restored", session: tokenStore.read() });
  }, []);

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}
