const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function parseError(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body && typeof body.detail === "string") detail = body.detail;
  } catch {}
  return new ApiError(response.status, detail);
}

export async function request(path, { method = "GET", body, token, signal } = {}) {
  const headers = { "Accept": "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return null;
  const payload = await response.json();
  return payload.data;
}

export const auth = {
  register: (body) => request("/auth/register", { method: "POST", body }),
  login: (body) => request("/auth/login", { method: "POST", body }),
  refresh: (refresh_token) => request("/auth/refresh", { method: "POST", body: { refresh_token } }),
  logout: (refresh_token) => request("/auth/logout", { method: "POST", body: { refresh_token } }),
};

export const conversations = {
  list: (token) => request("/conversations", { token }),
  create: (token, title) => request("/conversations", { method: "POST", token, body: { title: title ?? null } }),
  detail: (token, id) => request(`/conversations/${id}`, { token }),
  rename: (token, id, title) => request(`/conversations/${id}`, { method: "PATCH", token, body: { title } }),
  remove: (token, id) => request(`/conversations/${id}`, { method: "DELETE", token }),
  sendMessage: (token, id, content) =>
    request(`/conversations/${id}/messages`, { method: "POST", token, body: { content } }),
  editAndRegenerate: (token, conversationId, messageId, content) =>
    request(
      `/conversations/${conversationId}/messages/${messageId}/edit-and-regenerate`,
      { method: "POST", token, body: { content } },
    ),
  regenerate: (token, conversationId, messageId) =>
    request(
      `/conversations/${conversationId}/messages/${messageId}/regenerate`,
      { method: "POST", token },
    ),
};

export const runs = {
  state: (token, runId) => request(`/runs/${runId}/state`, { token }),
  cancel: (token, runId) => request(`/runs/${runId}/cancel`, { method: "POST", token }),
};
