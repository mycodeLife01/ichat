import { useCallback } from "react";

import type { LoginRequest, RegisterRequest } from "../api/auth";
import type { AuthUserResponse } from "../api/types";
import { useAppActions, useAppState } from "../app/context";
import { createAuthSession, tokenStore } from "./tokenStore";

export function useAuthSession() {
  const { auth } = useAppState();
  const { dispatch, services, streamAbort } = useAppActions();

  const login = useCallback(
    async (body: LoginRequest): Promise<void> => {
      dispatch({ type: "auth/submitStarted" });
      try {
        const tokens = await services.authApi.login(body);
        const session = createAuthSession(tokens);
        tokenStore.save(session);
        dispatch({ type: "auth/loggedIn", session });
      } catch (error) {
        dispatch({ type: "auth/submitFailed" });
        throw error;
      }
    },
    [dispatch, services],
  );

  const register = useCallback(
    async (body: RegisterRequest): Promise<void> => {
      dispatch({ type: "auth/submitStarted" });
      try {
        const tokens = await services.authApi.register(body);
        const session = createAuthSession(tokens);
        tokenStore.save(session);
        dispatch({ type: "auth/loggedIn", session });
      } catch (error) {
        dispatch({ type: "auth/submitFailed" });
        throw error;
      }
    },
    [dispatch, services],
  );

  const logout = useCallback(async (): Promise<void> => {
    const refreshToken = tokenStore.getRefreshToken();
    if (refreshToken) {
      try {
        await services.authApi.logout(refreshToken);
      } catch {
        // Best-effort: ignore logout API failure and still clear locally.
      }
    }
    streamAbort.abort();
    tokenStore.clear();
    dispatch({ type: "app/reset" });
  }, [dispatch, services, streamAbort]);

  // Refresh the cached user mirror (e.g. after email verification). Keeps the
  // same session/tokens; throws on failure (401 is handled by the API client).
  const refreshUser = useCallback(async (): Promise<AuthUserResponse> => {
    const user = await services.authApi.me();
    tokenStore.updateUser(user);
    dispatch({ type: "auth/userUpdated", user });
    return user;
  }, [dispatch, services]);

  return {
    session: auth.session,
    user: auth.session?.user ?? null,
    isAuthenticated: auth.session !== null,
    isSubmitting: auth.status === "submitting",
    bootstrapped: auth.bootstrapped,
    login,
    register,
    logout,
    refreshUser,
  };
}
