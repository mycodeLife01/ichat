import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";

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
import { initialState, rootReducer, type AppAction, type AppState } from "./store";

type AppProviderProps = {
  children: ReactNode;
  /** Test seam: inject fake services to bypass the real HTTP client. */
  services?: Services;
};

export function AppProvider({ children, services: injectedServices }: AppProviderProps) {
  const [state, rawDispatch] = useReducer(rootReducer, initialState);

  // Advance a mirror of state synchronously on each dispatch so async handlers
  // can read the latest selection without waiting for a render to commit. The
  // reducer is pure, so recomputing here yields the same value React commits.
  const stateRef = useRef<AppState>(initialState);
  const dispatch = useCallback<Dispatch<AppAction>>((action) => {
    stateRef.current = rootReducer(stateRef.current, action);
    rawDispatch(action);
  }, []);

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
    () => ({ dispatch, services, streamAbort, stateRef }),
    [dispatch, services, streamAbort],
  );

  useEffect(() => {
    dispatch({ type: "auth/restored", session: tokenStore.read() });
  }, [dispatch]);

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}
