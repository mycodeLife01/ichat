import { ApiError, auth as authApi, request } from "./api.js";

const STORAGE_KEY = "ichat.auth";
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(state) {
  if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  else localStorage.removeItem(STORAGE_KEY);
  for (const l of listeners) l(state);
}

let current = load();

export function getAuth() {
  return current;
}

export function onAuthChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setFromTokenResponse(data) {
  current = {
    user: data.user,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  save(current);
}

export async function login(identifier, password) {
  const data = await authApi.login({ identifier, password });
  setFromTokenResponse(data);
}

export async function register(username, email, password) {
  const data = await authApi.register({ username, email, password });
  setFromTokenResponse(data);
}

export async function logout() {
  const state = current;
  current = null;
  save(null);
  if (state?.refreshToken) {
    try { await authApi.logout(state.refreshToken); } catch {}
  }
}

async function refreshOnce() {
  if (!current?.refreshToken) throw new ApiError(401, "Not authenticated");
  const data = await authApi.refresh(current.refreshToken);
  setFromTokenResponse(data);
  return current.accessToken;
}

// Wrap an API call so a single 401 triggers refresh + retry.
export async function withAuth(callWithToken) {
  if (!current?.accessToken) throw new ApiError(401, "Not authenticated");
  try {
    return await callWithToken(current.accessToken);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    let token;
    try {
      token = await refreshOnce();
    } catch (refreshErr) {
      current = null;
      save(null);
      throw refreshErr;
    }
    return await callWithToken(token);
  }
}

export function getAccessToken() {
  return current?.accessToken ?? null;
}
