import type { AuthTokenResponse, AuthUserResponse } from "../api/types";

const AUTH_STORAGE_KEY = "ichat.auth";

export type AuthSession = {
  user: AuthUserResponse;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
};

export type TokenStore = {
  read(): AuthSession | null;
  save(session: AuthSession): void;
  clear(): void;
  updateUser(user: AuthUserResponse): void;
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
};

export function createAuthSession(
  response: AuthTokenResponse,
  now = Date.now(),
): AuthSession {
  return {
    user: response.user,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: response.token_type,
    expiresAt: now + response.expires_in * 1000,
  };
}

function readSession(): AuthSession | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);

  if (!raw) return null;

  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

export const tokenStore: TokenStore = {
  read() {
    return readSession();
  },
  save(session) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  },
  clear() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  },
  updateUser(user) {
    const session = readSession();
    if (session) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ ...session, user }));
    }
  },
  getAccessToken() {
    return readSession()?.accessToken ?? null;
  },
  getRefreshToken() {
    return readSession()?.refreshToken ?? null;
  },
};
