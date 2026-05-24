# Frontend Communication Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a typed, tested frontend communication foundation for JSON API calls, auth token storage, 401 refresh/retry, endpoint wrappers, and fetch-based SSE streaming.

**Architecture:** Keep the communication layer as pure TypeScript under `frontend/src/api/` and `frontend/src/auth/`, with no React imports. Endpoint wrappers consume one shared API client, tests use injected `fetch` and localStorage, and run streaming uses the same auth/error primitives as JSON requests while parsing SSE frames separately.

**Tech Stack:** Vite, TypeScript, Vitest, browser `fetch`, `ReadableStream`, localStorage, existing pnpm frontend toolchain.

---

## Execution Notes

- Work directly on the current branch. Do not create or switch to a git worktree.
- Keep `uiux_v1.html` untouched if it remains untracked.
- Use pnpm commands from `frontend/package.json`.
- Use TDD for each task: write the failing test first, run it, implement the smallest passing code, run focused verification, then commit.
- Do not add new dependencies.
- Do not modify backend code in this plan.
- Do not implement React Context, reducers, hooks, or UI components in this plan.

## File Structure

- Create `frontend/src/api/types.ts` for DTOs that mirror current backend Pydantic schemas.
- Create `frontend/src/test/apiFixtures.ts` for reusable typed response fixtures.
- Create `frontend/src/api/env.ts` for API base URL normalization and lookup.
- Create `frontend/src/api/errors.ts` for `ApiError`, abort detection, and Chinese error message mapping.
- Create `frontend/src/auth/tokenStore.ts` for localStorage auth session persistence.
- Create `frontend/src/api/client.ts` for JSON requests, auth header injection, envelope parsing, refresh/retry, and raw authenticated fetch.
- Create `frontend/src/api/auth.ts` for auth endpoint wrappers.
- Create `frontend/src/api/conversations.ts` for conversation and message endpoint wrappers.
- Create `frontend/src/api/sse.ts` for SSE frame parsing and stream decoding.
- Create `frontend/src/test/stream.ts` for controlled `ReadableStream<Uint8Array>` test helpers.
- Create `frontend/src/api/runs.ts` for run state, cancel, and stream endpoint wrappers.
- Create `frontend/src/api/index.ts` for public exports.
- Delete `.gitkeep` files in `frontend/src/api/` and `frontend/src/auth/` when real files are added.
- Keep existing `frontend/src/app/App.tsx`, `frontend/src/app/App.test.tsx`, `frontend/src/main.tsx`, and `frontend/src/styles/global.css` unchanged.

## Task 1: Add Backend DTO Types And Fixtures

**Files:**
- Create: `frontend/src/api/types.ts`
- Create: `frontend/src/test/apiFixtures.ts`
- Delete: `frontend/src/api/.gitkeep`
- Test: `frontend/src/test/apiFixtures.ts` via `pnpm run typecheck`

- [ ] **Step 1: Write typed fixtures that reference missing DTOs**

Create `frontend/src/test/apiFixtures.ts`:

```ts
import type {
  AuthTokenResponse,
  ConversationDetailResponse,
  ConversationResponse,
  RunEventResponse,
  RunResponse,
  RunStateResponse,
  SendMessageResponse,
  SuccessEnvelope,
} from "../api/types";

export const authTokenResponse: AuthTokenResponse = {
  user: {
    id: 1,
    username: "alice",
    email: "alice@example.com",
    email_verified: false,
  },
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
};

export const conversationResponse: ConversationResponse = {
  id: 10,
  title: "First chat",
  activated_at: "2026-05-24T10:00:00Z",
  created_at: "2026-05-24T09:59:00Z",
  updated_at: "2026-05-24T10:01:00Z",
};

export const assistantRun: RunResponse = {
  id: 100,
  conversation_id: conversationResponse.id,
  user_message_id: 501,
  status: "streaming",
  provider_name: "deepseek",
  provider_model: "deepseek-chat",
  created_at: "2026-05-24T10:02:00Z",
};

export const sendMessageResponse: SendMessageResponse = {
  message: {
    id: 501,
    conversation_id: conversationResponse.id,
    run_id: assistantRun.id,
    role: "user",
    content: "Hello",
    reasoning: null,
    position: 1,
    created_at: "2026-05-24T10:02:00Z",
  },
  run: assistantRun,
};

export const conversationDetailResponse: ConversationDetailResponse = {
  ...conversationResponse,
  messages: [sendMessageResponse.message],
};

export const textDeltaEvent: RunEventResponse = {
  seq: 1,
  type: "text_delta",
  payload: { text: "Hello" },
  created_at: "2026-05-24T10:02:01Z",
};

export const succeededEvent: RunEventResponse = {
  seq: 2,
  type: "run_succeeded",
  payload: {},
  created_at: "2026-05-24T10:02:02Z",
};

export const runStateResponse: RunStateResponse = {
  run_id: assistantRun.id,
  status: "streaming",
  latest_seq: 1,
  draft_text: "Hello",
  draft_reasoning: "",
  terminal_event: null,
};

export function envelope<T>(data: T): SuccessEnvelope<T> {
  return { data };
}
```

- [ ] **Step 2: Run typecheck to verify RED**

Run:

```bash
cd frontend
pnpm run typecheck
```

Expected: FAIL because `../api/types` does not exist.

- [ ] **Step 3: Add DTO types**

Create `frontend/src/api/types.ts`:

```ts
export type SuccessEnvelope<T> = {
  data: T;
  meta?: Record<string, unknown> | null;
};

export type AuthUserResponse = {
  id: number;
  username: string;
  email: string;
  email_verified: boolean;
};

export type AuthTokenResponse = {
  user: AuthUserResponse;
  access_token: string;
  refresh_token: string;
  token_type: "bearer" | string;
  expires_in: number;
};

export type CommandStatusResponse = {
  status: string;
};

export type ConversationResponse = {
  id: number;
  title: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRole = "user" | "assistant";

export type MessageResponse = {
  id: number;
  conversation_id: number;
  run_id: number | null;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  position: number;
  created_at: string;
};

export type RunStatus =
  | "queued"
  | "started"
  | "streaming"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export type RunResponse = {
  id: number;
  conversation_id: number;
  user_message_id: number;
  status: RunStatus;
  provider_name: string;
  provider_model: string;
  created_at: string;
};

export type ConversationDetailResponse = ConversationResponse & {
  messages: MessageResponse[];
};

export type SendMessageResponse = {
  message: MessageResponse;
  run: RunResponse;
};

export type RunEventType =
  | "run_started"
  | "text_delta"
  | "reasoning_delta"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled";

export type RunEventResponse = {
  seq: number;
  type: RunEventType;
  payload: Record<string, unknown>;
  created_at: string;
};

export type RunStateResponse = {
  run_id: number;
  status: RunStatus;
  latest_seq: number;
  draft_text: string;
  draft_reasoning: string;
  terminal_event: RunEventResponse | null;
};
```

- [ ] **Step 4: Remove obsolete placeholder**

Delete `frontend/src/api/.gitkeep`.

- [ ] **Step 5: Run typecheck to verify GREEN**

Run:

```bash
cd frontend
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/api/types.ts frontend/src/test/apiFixtures.ts frontend/src/api/.gitkeep
git commit -m "feat(frontend): add api response types"
```

Expected: commit succeeds with the DTO types and fixtures.

## Task 2: Add API Env And Error Primitives

**Files:**
- Create: `frontend/src/api/env.test.ts`
- Create: `frontend/src/api/env.ts`
- Create: `frontend/src/api/errors.test.ts`
- Create: `frontend/src/api/errors.ts`

- [ ] **Step 1: Write failing env tests**

Create `frontend/src/api/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl } from "./env";

describe("normalizeApiBaseUrl", () => {
  it("removes trailing slashes", () => {
    expect(normalizeApiBaseUrl("https://api.feslia.com/api/v1/")).toBe(
      "https://api.feslia.com/api/v1",
    );
  });

  it("throws when the value is empty", () => {
    expect(() => normalizeApiBaseUrl("")).toThrow(
      "VITE_API_BASE_URL is required",
    );
  });
});
```

- [ ] **Step 2: Run env tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/env.test.ts --run
```

Expected: FAIL because `frontend/src/api/env.ts` does not exist.

- [ ] **Step 3: Implement env helpers**

Create `frontend/src/api/env.ts`:

```ts
export function normalizeApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new Error("VITE_API_BASE_URL is required");
  }

  return trimmed.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  return normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
}
```

- [ ] **Step 4: Verify env tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/env.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Write failing error tests**

Create `frontend/src/api/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ApiError,
  getDefaultErrorMessage,
  isAbortError,
  toApiError,
} from "./errors";

describe("ApiError", () => {
  it("stores status, message, detail, and payload", () => {
    const error = new ApiError({
      status: 409,
      message: "当前操作与现有状态冲突，请稍后重试",
      detail: "active run exists",
      payload: { detail: "active run exists" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(409);
    expect(error.detail).toBe("active run exists");
  });

  it("maps common statuses to Chinese messages", () => {
    expect(getDefaultErrorMessage(401)).toBe("登录状态已失效，请重新登录");
    expect(getDefaultErrorMessage(403)).toBe("没有权限访问该资源");
    expect(getDefaultErrorMessage(404)).toBe("资源不存在或已被删除");
    expect(getDefaultErrorMessage(409)).toBe("当前操作与现有状态冲突，请稍后重试");
    expect(getDefaultErrorMessage(422)).toBe("提交内容不符合要求，请检查后重试");
    expect(getDefaultErrorMessage(500)).toBe("服务暂时不可用，请稍后重试");
  });

  it("keeps abort errors recognizable", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");

    expect(isAbortError(abort)).toBe(true);
    expect(toApiError(abort).isAbort).toBe(true);
  });
});
```

- [ ] **Step 6: Run error tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/errors.test.ts --run
```

Expected: FAIL because `frontend/src/api/errors.ts` does not exist.

- [ ] **Step 7: Implement error primitives**

Create `frontend/src/api/errors.ts`:

```ts
type ApiErrorOptions = {
  status: number;
  message?: string;
  detail?: unknown;
  payload?: unknown;
  isAuthExpired?: boolean;
  isAbort?: boolean;
  cause?: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: unknown;
  readonly payload?: unknown;
  readonly isAuthExpired: boolean;
  readonly isAbort: boolean;

  constructor(options: ApiErrorOptions) {
    super(options.message ?? getDefaultErrorMessage(options.status), {
      cause: options.cause,
    });
    this.name = "ApiError";
    this.status = options.status;
    this.detail = options.detail;
    this.payload = options.payload;
    this.isAuthExpired = options.isAuthExpired ?? false;
    this.isAbort = options.isAbort ?? false;
  }
}

export function getDefaultErrorMessage(status: number): string {
  if (status === 401) return "登录状态已失效，请重新登录";
  if (status === 403) return "没有权限访问该资源";
  if (status === 404) return "资源不存在或已被删除";
  if (status === 409) return "当前操作与现有状态冲突，请稍后重试";
  if (status === 422) return "提交内容不符合要求，请检查后重试";
  if (status >= 500) return "服务暂时不可用，请稍后重试";
  return "请求失败，请稍后重试";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (isAbortError(error)) {
    return new ApiError({
      status: 0,
      message: "请求已取消",
      isAbort: true,
      cause: error,
    });
  }

  return new ApiError({
    status: 0,
    message: "网络连接失败，请检查后重试",
    cause: error,
  });
}

export function getErrorDetail(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "detail" in payload) {
    return (payload as { detail: unknown }).detail;
  }

  return undefined;
}
```

- [ ] **Step 8: Verify task tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/env.test.ts src/api/errors.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add frontend/src/api/env.ts frontend/src/api/env.test.ts frontend/src/api/errors.ts frontend/src/api/errors.test.ts
git commit -m "feat(frontend): add api env and errors"
```

Expected: commit succeeds with env and error primitives.

## Task 3: Add Auth Token Store

**Files:**
- Create: `frontend/src/auth/tokenStore.test.ts`
- Create: `frontend/src/auth/tokenStore.ts`
- Delete: `frontend/src/auth/.gitkeep`

- [ ] **Step 1: Write failing token store tests**

Create `frontend/src/auth/tokenStore.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { createAuthSession, tokenStore } from "./tokenStore";
import { authTokenResponse } from "../test/apiFixtures";

describe("tokenStore", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("saves and reads an auth session", () => {
    const session = createAuthSession(authTokenResponse, 1_000);

    tokenStore.save(session);

    expect(tokenStore.read()).toEqual(session);
    expect(tokenStore.getAccessToken()).toBe("access-token");
    expect(tokenStore.getRefreshToken()).toBe("refresh-token");
  });

  it("clears the stored session", () => {
    tokenStore.save(createAuthSession(authTokenResponse, 1_000));

    tokenStore.clear();

    expect(tokenStore.read()).toBeNull();
  });

  it("clears invalid JSON and returns null", () => {
    localStorage.setItem("ichat.auth", "{bad json");

    expect(tokenStore.read()).toBeNull();
    expect(localStorage.getItem("ichat.auth")).toBeNull();
  });
});
```

- [ ] **Step 2: Run token store tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/auth/tokenStore.test.ts --run
```

Expected: FAIL because `frontend/src/auth/tokenStore.ts` does not exist.

- [ ] **Step 3: Implement token store**

Create `frontend/src/auth/tokenStore.ts`:

```ts
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
  getAccessToken() {
    return readSession()?.accessToken ?? null;
  },
  getRefreshToken() {
    return readSession()?.refreshToken ?? null;
  },
};
```

- [ ] **Step 4: Remove obsolete placeholder**

Delete `frontend/src/auth/.gitkeep`.

- [ ] **Step 5: Verify token store tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/auth/tokenStore.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/auth/tokenStore.ts frontend/src/auth/tokenStore.test.ts frontend/src/auth/.gitkeep
git commit -m "feat(frontend): add auth token store"
```

Expected: commit succeeds with token persistence helpers.

## Task 4: Add JSON API Client Without Refresh

**Files:**
- Create: `frontend/src/api/client.test.ts`
- Create: `frontend/src/api/client.ts`

- [ ] **Step 1: Write failing JSON client tests**

Create `frontend/src/api/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "./client";
import { ApiError } from "./errors";
import { tokenStore } from "../auth/tokenStore";
import { authTokenResponse, conversationResponse, envelope } from "../test/apiFixtures";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("ApiClient JSON requests", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads data from success envelopes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(envelope(conversationResponse)));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl });

    await expect(client.request("/conversations")).resolves.toEqual(conversationResponse);
  });

  it("builds method, JSON body, query, and authorization headers", async () => {
    tokenStore.save({
      user: authTokenResponse.user,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "bearer",
      expiresAt: Date.now() + 3600_000,
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(envelope(conversationResponse)));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl, tokenStore });

    await client.request("/conversations/10", {
      method: "PATCH",
      body: { title: "Renamed" },
      query: { after_seq: 2 },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.test/api/v1/conversations/10?after_seq=2",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("throws ApiError for non-2xx JSON responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ detail: "active run exists" }, { status: 409 }),
    );
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl });

    await expect(client.request("/conversations")).rejects.toMatchObject({
      status: 409,
      detail: "active run exists",
    });
  });

  it("throws ApiError when success envelope has no data field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl });

    await expect(client.request("/conversations")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run JSON client tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/client.test.ts --run
```

Expected: FAIL because `frontend/src/api/client.ts` does not exist.

- [ ] **Step 3: Implement JSON client base behavior**

Create `frontend/src/api/client.ts`:

```ts
import { tokenStore as defaultTokenStore, type TokenStore } from "../auth/tokenStore";
import { getApiBaseUrl } from "./env";
import { ApiError, getDefaultErrorMessage, getErrorDetail, toApiError } from "./errors";
import type { SuccessEnvelope } from "./types";

type QueryValue = string | number | boolean | null | undefined;

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  auth?: boolean;
  retryOnUnauthorized?: boolean;
};

export type ApiClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  tokenStore?: TokenStore;
  onAuthExpired?: () => void;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenStore: TokenStore;
  private readonly onAuthExpired?: () => void;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenStore = options.tokenStore ?? defaultTokenStore;
    this.onAuthExpired = options.onAuthExpired;
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    try {
      const response = await this.fetchRaw(path, options);
      const payload = (await response.json()) as SuccessEnvelope<T>;

      if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new ApiError({
          status: response.status,
          message: "服务响应格式异常",
          payload,
        });
      }

      return payload.data;
    } catch (error) {
      throw toApiError(error);
    }
  }

  async fetchRaw(path: string, options: ApiRequestOptions = {}): Promise<Response> {
    const response = await this.fetchImpl(this.buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers: this.buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    if (!response.ok) {
      throw await this.createResponseError(response);
    }

    return response;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private buildHeaders(options: ApiRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (options.auth !== false) {
      const accessToken = this.tokenStore.getAccessToken();
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
    }

    return headers;
  }

  private async createResponseError(response: Response): Promise<ApiError> {
    const payload = await readJsonSafely(response);
    const detail = getErrorDetail(payload);

    return new ApiError({
      status: response.status,
      message: getDefaultErrorMessage(response.status),
      detail,
      payload,
    });
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

let defaultApiClient: ApiClient | null = null;

export function getDefaultApiClient(): ApiClient {
  defaultApiClient ??= new ApiClient();
  return defaultApiClient;
}
```

- [ ] **Step 4: Verify JSON client tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/client.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(frontend): add json api client"
```

Expected: commit succeeds with base JSON client behavior.

## Task 5: Add Refresh Retry And Auth Endpoint Wrappers

**Files:**
- Modify: `frontend/src/api/client.test.ts`
- Modify: `frontend/src/api/client.ts`
- Create: `frontend/src/api/auth.test.ts`
- Create: `frontend/src/api/auth.ts`

- [ ] **Step 1: Add failing refresh/retry tests**

Append to `frontend/src/api/client.test.ts`:

```ts
describe("ApiClient refresh retry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("refreshes once and retries the original request after 401", async () => {
    tokenStore.save({
      user: authTokenResponse.user,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "bearer",
      expiresAt: Date.now() - 1,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            ...authTokenResponse,
            access_token: "new-access",
            refresh_token: "new-refresh",
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(envelope(conversationResponse)));
    const client = new ApiClient({ baseUrl: "http://api.test/api/v1", fetchImpl, tokenStore });

    await expect(client.request("/conversations")).resolves.toEqual(conversationResponse);
    expect(tokenStore.getAccessToken()).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("clears tokens and calls onAuthExpired when refresh fails", async () => {
    tokenStore.save({
      user: authTokenResponse.user,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "bearer",
      expiresAt: Date.now() - 1,
    });
    const onAuthExpired = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ detail: "invalid refresh" }, { status: 401 }));
    const client = new ApiClient({
      baseUrl: "http://api.test/api/v1",
      fetchImpl,
      tokenStore,
      onAuthExpired,
    });

    await expect(client.request("/conversations")).rejects.toMatchObject({
      status: 401,
      isAuthExpired: true,
    });
    expect(tokenStore.read()).toBeNull();
    expect(onAuthExpired).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run refresh tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/client.test.ts --run
```

Expected: FAIL because `ApiClient` does not retry 401.

- [ ] **Step 3: Implement refresh/retry in client**

Modify `frontend/src/api/client.ts`:

```ts
import {
  createAuthSession,
  tokenStore as defaultTokenStore,
  type TokenStore,
} from "../auth/tokenStore";
import { getApiBaseUrl } from "./env";
import { ApiError, getDefaultErrorMessage, getErrorDetail, toApiError } from "./errors";
import type { AuthTokenResponse, SuccessEnvelope } from "./types";

type QueryValue = string | number | boolean | null | undefined;

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  auth?: boolean;
  retryOnUnauthorized?: boolean;
};

export type ApiClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  tokenStore?: TokenStore;
  onAuthExpired?: () => void;
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenStore: TokenStore;
  private readonly onAuthExpired?: () => void;
  private refreshPromise: Promise<AuthTokenResponse> | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenStore = options.tokenStore ?? defaultTokenStore;
    this.onAuthExpired = options.onAuthExpired;
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    try {
      const response = await this.fetchRaw(path, options);
      const payload = (await response.json()) as SuccessEnvelope<T>;

      if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new ApiError({
          status: response.status,
          message: "服务响应格式异常",
          payload,
        });
      }

      return payload.data;
    } catch (error) {
      throw toApiError(error);
    }
  }

  async fetchRaw(path: string, options: ApiRequestOptions = {}): Promise<Response> {
    return this.fetchRawInternal(path, options, false);
  }

  private async fetchRawInternal(
    path: string,
    options: ApiRequestOptions,
    hasRetried: boolean,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers: this.buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    if (
      response.status === 401 &&
      options.auth !== false &&
      options.retryOnUnauthorized !== false &&
      !hasRetried
    ) {
      await this.refreshSession();
      return this.fetchRawInternal(path, options, true);
    }

    if (!response.ok) {
      throw await this.createResponseError(response);
    }

    return response;
  }

  private async refreshSession(): Promise<void> {
    const refreshToken = this.tokenStore.getRefreshToken();

    if (!refreshToken) {
      this.expireAuth();
      throw new ApiError({
        status: 401,
        message: "登录状态已失效，请重新登录",
        isAuthExpired: true,
      });
    }

    try {
      this.refreshPromise ??= this.request<AuthTokenResponse>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      }).finally(() => {
        this.refreshPromise = null;
      });

      const refreshed = await this.refreshPromise;
      this.tokenStore.save(createAuthSession(refreshed));
    } catch (error) {
      this.expireAuth();
      const apiError = toApiError(error);
      throw new ApiError({
        status: apiError.status || 401,
        message: "登录状态已失效，请重新登录",
        detail: apiError.detail,
        payload: apiError.payload,
        isAuthExpired: true,
        cause: error,
      });
    }
  }

  private expireAuth(): void {
    this.tokenStore.clear();
    this.onAuthExpired?.();
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private buildHeaders(options: ApiRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (options.auth !== false) {
      const accessToken = this.tokenStore.getAccessToken();
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
    }

    return headers;
  }

  private async createResponseError(response: Response): Promise<ApiError> {
    const payload = await readJsonSafely(response);
    const detail = getErrorDetail(payload);

    return new ApiError({
      status: response.status,
      message: getDefaultErrorMessage(response.status),
      detail,
      payload,
    });
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

let defaultApiClient: ApiClient | null = null;

export function getDefaultApiClient(): ApiClient {
  defaultApiClient ??= new ApiClient();
  return defaultApiClient;
}
```

- [ ] **Step 4: Verify refresh tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/client.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Write failing auth wrapper tests**

Create `frontend/src/api/auth.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createAuthApi } from "./auth";
import type { ApiClient } from "./client";
import { authTokenResponse } from "../test/apiFixtures";

function mockClient() {
  return {
    request: vi.fn(),
  } as unknown as Pick<ApiClient, "request">;
}

describe("authApi", () => {
  it("posts register payload", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(authTokenResponse);
    const authApi = createAuthApi(client);

    await authApi.register({
      username: "alice",
      email: "alice@example.com",
      password: "password123",
    });

    expect(client.request).toHaveBeenCalledWith("/auth/register", {
      method: "POST",
      body: {
        username: "alice",
        email: "alice@example.com",
        password: "password123",
      },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("posts login payload", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(authTokenResponse);
    const authApi = createAuthApi(client);

    await authApi.login({ identifier: "alice", password: "password123" });

    expect(client.request).toHaveBeenCalledWith("/auth/login", {
      method: "POST",
      body: { identifier: "alice", password: "password123" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("posts logout payload", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue({ status: "ok" });
    const authApi = createAuthApi(client);

    await authApi.logout("refresh-token");

    expect(client.request).toHaveBeenCalledWith("/auth/logout", {
      method: "POST",
      body: { refresh_token: "refresh-token" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });
});
```

- [ ] **Step 6: Run auth wrapper tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/auth.test.ts --run
```

Expected: FAIL because `frontend/src/api/auth.ts` does not exist.

- [ ] **Step 7: Implement auth wrappers**

Create `frontend/src/api/auth.ts`:

```ts
import { getDefaultApiClient, type ApiClient } from "./client";
import type { AuthTokenResponse, CommandStatusResponse } from "./types";

export type RegisterRequest = {
  username: string;
  email: string;
  password: string;
};

export type LoginRequest = {
  identifier: string;
  password: string;
};

export function createAuthApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    register(body: RegisterRequest): Promise<AuthTokenResponse> {
      return resolveClient().request<AuthTokenResponse>("/auth/register", {
        method: "POST",
        body,
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    login(body: LoginRequest): Promise<AuthTokenResponse> {
      return resolveClient().request<AuthTokenResponse>("/auth/login", {
        method: "POST",
        body,
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    refresh(refreshToken: string): Promise<AuthTokenResponse> {
      return resolveClient().request<AuthTokenResponse>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    logout(refreshToken: string): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>("/auth/logout", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      });
    },
  };
}

export const authApi = createAuthApi();
```

- [ ] **Step 8: Verify task tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/client.test.ts src/api/auth.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add frontend/src/api/client.ts frontend/src/api/client.test.ts frontend/src/api/auth.ts frontend/src/api/auth.test.ts
git commit -m "feat(frontend): add auth api refresh retry"
```

Expected: commit succeeds with refresh/retry and auth wrappers.

## Task 6: Add Conversation Endpoint Wrappers

**Files:**
- Create: `frontend/src/api/conversations.test.ts`
- Create: `frontend/src/api/conversations.ts`

- [ ] **Step 1: Write failing conversation wrapper tests**

Create `frontend/src/api/conversations.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createConversationApi } from "./conversations";
import type { ApiClient } from "./client";
import {
  conversationDetailResponse,
  conversationResponse,
  sendMessageResponse,
} from "../test/apiFixtures";

function mockClient() {
  return {
    request: vi.fn(),
  } as unknown as Pick<ApiClient, "request">;
}

describe("conversationApi", () => {
  it("lists conversations", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue([conversationResponse]);
    const api = createConversationApi(client);

    await api.list();

    expect(client.request).toHaveBeenCalledWith("/conversations");
  });

  it("creates a conversation with optional title", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(conversationResponse);
    const api = createConversationApi(client);

    await api.create("Draft");

    expect(client.request).toHaveBeenCalledWith("/conversations", {
      method: "POST",
      body: { title: "Draft" },
    });
  });

  it("loads conversation detail", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(conversationDetailResponse);
    const api = createConversationApi(client);

    await api.detail(10);

    expect(client.request).toHaveBeenCalledWith("/conversations/10");
  });

  it("renames and removes conversations", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce(conversationResponse);
    vi.mocked(client.request).mockResolvedValueOnce({ status: "ok" });
    const api = createConversationApi(client);

    await api.rename(10, "Renamed");
    await api.remove(10);

    expect(client.request).toHaveBeenNthCalledWith(1, "/conversations/10", {
      method: "PATCH",
      body: { title: "Renamed" },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "/conversations/10", {
      method: "DELETE",
    });
  });

  it("sends, edits, and regenerates messages with backend paths", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValue(sendMessageResponse);
    const api = createConversationApi(client);

    await api.sendMessage(10, "Hello");
    await api.editAndRegenerate(10, 501, "Edited");
    await api.regenerate(10, 502);

    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "/conversations/10/messages",
      { method: "POST", body: { content: "Hello" } },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "/conversations/10/messages/501/edit-and-regenerate",
      { method: "POST", body: { content: "Edited" } },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "/conversations/10/messages/502/regenerate",
      { method: "POST" },
    );
  });
});
```

- [ ] **Step 2: Run conversation wrapper tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/conversations.test.ts --run
```

Expected: FAIL because `frontend/src/api/conversations.ts` does not exist.

- [ ] **Step 3: Implement conversation wrappers**

Create `frontend/src/api/conversations.ts`:

```ts
import { getDefaultApiClient, type ApiClient } from "./client";
import type {
  CommandStatusResponse,
  ConversationDetailResponse,
  ConversationResponse,
  SendMessageResponse,
} from "./types";

export function createConversationApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    list(): Promise<ConversationResponse[]> {
      return resolveClient().request<ConversationResponse[]>("/conversations");
    },
    create(title?: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>("/conversations", {
        method: "POST",
        body: { title: title ?? null },
      });
    },
    detail(conversationId: number): Promise<ConversationDetailResponse> {
      return resolveClient().request<ConversationDetailResponse>(
        `/conversations/${conversationId}`,
      );
    },
    rename(conversationId: number, title: string): Promise<ConversationResponse> {
      return resolveClient().request<ConversationResponse>(`/conversations/${conversationId}`, {
        method: "PATCH",
        body: { title },
      });
    },
    remove(conversationId: number): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>(
        `/conversations/${conversationId}`,
        { method: "DELETE" },
      );
    },
    sendMessage(conversationId: number, content: string): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages`,
        { method: "POST", body: { content } },
      );
    },
    editAndRegenerate(
      conversationId: number,
      messageId: number,
      content: string,
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages/${messageId}/edit-and-regenerate`,
        { method: "POST", body: { content } },
      );
    },
    regenerate(
      conversationId: number,
      messageId: number,
    ): Promise<SendMessageResponse> {
      return resolveClient().request<SendMessageResponse>(
        `/conversations/${conversationId}/messages/${messageId}/regenerate`,
        { method: "POST" },
      );
    },
  };
}

export const conversationApi = createConversationApi();
```

- [ ] **Step 4: Verify conversation wrapper tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/conversations.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src/api/conversations.ts frontend/src/api/conversations.test.ts
git commit -m "feat(frontend): add conversation api wrappers"
```

Expected: commit succeeds with conversation wrappers.

## Task 7: Add SSE Parser And Stream Test Helper

**Files:**
- Create: `frontend/src/api/sse.test.ts`
- Create: `frontend/src/api/sse.ts`
- Create: `frontend/src/test/stream.ts`

- [ ] **Step 1: Write failing SSE parser tests**

Create `frontend/src/api/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { SseParser, decodeSseStream } from "./sse";
import { readableTextStream } from "../test/stream";

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

describe("SseParser", () => {
  it("parses a complete event", () => {
    const parser = new SseParser();

    expect(
      parser.push('id: 1\nevent: text_delta\ndata: {"seq":1}\n\n'),
    ).toEqual([{ id: "1", event: "text_delta", data: '{"seq":1}' }]);
  });

  it("parses multiple events from one chunk", () => {
    const parser = new SseParser();

    expect(parser.push("id: 1\ndata: a\n\nid: 2\ndata: b\n\n")).toEqual([
      { id: "1", data: "a" },
      { id: "2", data: "b" },
    ]);
  });

  it("keeps buffer across chunk boundaries", () => {
    const parser = new SseParser();

    expect(parser.push("id: 1\nevent: text")).toEqual([]);
    expect(parser.push('_delta\ndata: {"seq":1}\n\n')).toEqual([
      { id: "1", event: "text_delta", data: '{"seq":1}' },
    ]);
  });

  it("joins multiple data lines and ignores comments", () => {
    const parser = new SseParser();

    expect(parser.push(": keepalive\ndata: line1\ndata: line2\n\n")).toEqual([
      { data: "line1\nline2" },
    ]);
  });
});

describe("decodeSseStream", () => {
  it("decodes text stream chunks into parsed events", async () => {
    const stream = readableTextStream(["id: 1\n", "data: hello\n\n"]);

    await expect(collectAsync(decodeSseStream(stream))).resolves.toEqual([
      { id: "1", data: "hello" },
    ]);
  });
});
```

- [ ] **Step 2: Write stream helper used by the failing test**

Create `frontend/src/test/stream.ts`:

```ts
export function readableTextStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}
```

- [ ] **Step 3: Run SSE tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/sse.test.ts --run
```

Expected: FAIL because `frontend/src/api/sse.ts` does not exist.

- [ ] **Step 4: Implement SSE parser and decoder**

Create `frontend/src/api/sse.ts`:

```ts
export type ParsedSseEvent = {
  id?: string;
  event?: string;
  data: string;
};

export class SseParser {
  private buffer = "";

  push(chunk: string): ParsedSseEvent[] {
    this.buffer += chunk;
    const events: ParsedSseEvent[] = [];

    while (true) {
      const boundary = this.findBoundary();
      if (boundary === -1) break;

      const rawEvent = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);

      const event = parseEvent(rawEvent);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private findBoundary(): { index: number; length: number } | -1 {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");

    if (lf === -1 && crlf === -1) return -1;
    if (lf === -1) return { index: crlf, length: 4 };
    if (crlf === -1) return { index: lf, length: 2 };
    return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
  }
}

export async function* decodeSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const event of parser.push(text)) {
        yield event;
      }
    }

    const remaining = decoder.decode();
    if (remaining) {
      for (const event of parser.push(remaining)) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(rawEvent: string): ParsedSseEvent | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    data: dataLines.join("\n"),
  };
}
```

- [ ] **Step 5: Verify SSE parser tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/sse.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/api/sse.ts frontend/src/api/sse.test.ts frontend/src/test/stream.ts
git commit -m "feat(frontend): add sse parser"
```

Expected: commit succeeds with parser and stream helper.

## Task 8: Add Run Endpoint Wrappers And Stream Events

**Files:**
- Create: `frontend/src/api/runs.test.ts`
- Create: `frontend/src/api/runs.ts`
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Add stream event type**

Append to `frontend/src/api/types.ts`:

```ts
export type RunStreamEvent = {
  seq: number;
  type: RunEventType;
  data: RunEventResponse;
};
```

- [ ] **Step 2: Write failing run wrapper tests**

Create `frontend/src/api/runs.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createRunApi } from "./runs";
import type { ApiClient } from "./client";
import {
  runStateResponse,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { readableTextStream } from "../test/stream";

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

function mockClient() {
  return {
    request: vi.fn(),
    fetchRaw: vi.fn(),
  } as unknown as Pick<ApiClient, "request" | "fetchRaw">;
}

describe("runApi", () => {
  it("loads run state and cancels runs", async () => {
    const client = mockClient();
    vi.mocked(client.request).mockResolvedValueOnce(runStateResponse);
    vi.mocked(client.request).mockResolvedValueOnce({ status: "ok" });
    const api = createRunApi(client);

    await api.state(100);
    await api.cancel(100);

    expect(client.request).toHaveBeenNthCalledWith(1, "/runs/100/state");
    expect(client.request).toHaveBeenNthCalledWith(2, "/runs/100/cancel", {
      method: "POST",
    });
  });

  it("streams run events with after_seq query and text/event-stream accept", async () => {
    const client = mockClient();
    vi.mocked(client.fetchRaw).mockResolvedValue(
      new Response(
        readableTextStream([
          `id: 1\nevent: text_delta\ndata: ${JSON.stringify(textDeltaEvent)}\n\n`,
          `id: 2\nevent: run_succeeded\ndata: ${JSON.stringify(succeededEvent)}\n\n`,
        ]),
        { status: 200 },
      ),
    );
    const api = createRunApi(client);

    await expect(collectAsync(api.streamEvents(100, 7))).resolves.toEqual([
      { seq: 1, type: "text_delta", data: textDeltaEvent },
      { seq: 2, type: "run_succeeded", data: succeededEvent },
    ]);

    expect(client.fetchRaw).toHaveBeenCalledWith("/runs/100/events", {
      query: { after_seq: 7 },
      headers: { Accept: "text/event-stream" },
    });
  });
});
```

- [ ] **Step 3: Run run wrapper tests to verify RED**

Run:

```bash
cd frontend
pnpm run test -- src/api/runs.test.ts --run
```

Expected: FAIL because `frontend/src/api/runs.ts` does not exist.

- [ ] **Step 4: Implement run wrappers and stream events**

Create `frontend/src/api/runs.ts`:

```ts
import { getDefaultApiClient, type ApiClient, type ApiRequestOptions } from "./client";
import { decodeSseStream } from "./sse";
import type {
  CommandStatusResponse,
  RunEventResponse,
  RunEventType,
  RunStateResponse,
  RunStreamEvent,
} from "./types";

const TERMINAL_EVENT_TYPES = new Set<RunEventType>([
  "run_succeeded",
  "run_failed",
  "run_cancelled",
]);

export function createRunApi(
  client?: Pick<ApiClient, "request" | "fetchRaw">,
) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    state(runId: number): Promise<RunStateResponse> {
      return resolveClient().request<RunStateResponse>(`/runs/${runId}/state`);
    },
    cancel(runId: number): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>(`/runs/${runId}/cancel`, {
        method: "POST",
      });
    },
    async *streamEvents(
      runId: number,
      afterSeq: number,
      options: Pick<ApiRequestOptions, "signal"> = {},
    ): AsyncGenerator<RunStreamEvent> {
      const response = await resolveClient().fetchRaw(`/runs/${runId}/events`, {
        query: { after_seq: afterSeq },
        headers: { Accept: "text/event-stream" },
        signal: options.signal,
      });

      if (!response.body) {
        throw new Error("SSE response body is empty");
      }

      for await (const event of decodeSseStream(response.body)) {
        const data = JSON.parse(event.data) as RunEventResponse;
        const streamEvent = {
          seq: data.seq,
          type: data.type,
          data,
        };

        yield streamEvent;

        if (TERMINAL_EVENT_TYPES.has(streamEvent.type)) {
          return;
        }
      }
    },
  };
}

export const runApi = createRunApi();
```

- [ ] **Step 5: Verify run wrapper tests pass**

Run:

```bash
cd frontend
pnpm run test -- src/api/runs.test.ts --run
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/api/runs.ts frontend/src/api/runs.test.ts frontend/src/api/types.ts
git commit -m "feat(frontend): add run api stream client"
```

Expected: commit succeeds with run wrappers and streaming support.

## Task 9: Add Public Exports And Full Verification

**Files:**
- Create: `frontend/src/api/index.ts`
- Modify: `frontend/src/api/index.ts` if it already exists from a worker's local attempt

- [ ] **Step 1: Add public API exports**

Create `frontend/src/api/index.ts`:

```ts
export { authApi, createAuthApi } from "./auth";
export { ApiClient, getDefaultApiClient } from "./client";
export { conversationApi, createConversationApi } from "./conversations";
export { ApiError, isAbortError, toApiError } from "./errors";
export { runApi, createRunApi } from "./runs";
export { SseParser, decodeSseStream } from "./sse";
export type {
  AuthTokenResponse,
  AuthUserResponse,
  CommandStatusResponse,
  ConversationDetailResponse,
  ConversationResponse,
  MessageResponse,
  RunEventResponse,
  RunEventType,
  RunResponse,
  RunStateResponse,
  RunStatus,
  RunStreamEvent,
  SendMessageResponse,
  SuccessEnvelope,
} from "./types";
```

- [ ] **Step 2: Run all frontend tests**

Run:

```bash
cd frontend
pnpm run test -- --run
```

Expected: PASS, including `src/app/App.test.tsx` and all new API/auth tests.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd frontend
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
cd frontend
pnpm run lint
```

Expected: PASS.

- [ ] **Step 5: Run production build**

Run:

```bash
cd frontend
pnpm run build
```

Expected: PASS and `frontend/dist/` is produced locally.

- [ ] **Step 6: Review git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only planned frontend communication files are modified or created. `uiux_v1.html` may remain untracked and must not be included.

- [ ] **Step 7: Commit**

Run:

```bash
git add frontend/src/api frontend/src/auth frontend/src/test
git commit -m "feat(frontend): expose communication foundation"
```

Expected: commit succeeds with public exports and any final small adjustments.

## Final Self-Review Checklist For Implementer

- [ ] `frontend/src/api/client.ts` does not import React.
- [ ] `frontend/src/api/sse.ts` does not import React.
- [ ] `frontend/src/auth/tokenStore.ts` does not import React.
- [ ] Every JSON success response goes through `SuccessEnvelope<T>` and returns `data`.
- [ ] 401 retry is limited to one retry for each original request.
- [ ] refresh requests use `auth: false` and `retryOnUnauthorized: false`.
- [ ] refresh failure clears `tokenStore` and calls `onAuthExpired`.
- [ ] `runApi.streamEvents` uses `fetchRaw` with `Accept: text/event-stream`.
- [ ] `runApi.streamEvents` stops on `run_succeeded`, `run_failed`, and `run_cancelled`.
- [ ] Endpoint wrapper paths match current FastAPI routes:
  - `/auth/register`
  - `/auth/login`
  - `/auth/refresh`
  - `/auth/logout`
  - `/conversations`
  - `/conversations/{conversation_id}`
  - `/conversations/{conversation_id}/messages`
  - `/conversations/{conversation_id}/messages/{message_id}/edit-and-regenerate`
  - `/conversations/{conversation_id}/messages/{message_id}/regenerate`
  - `/runs/{run_id}/state`
  - `/runs/{run_id}/cancel`
  - `/runs/{run_id}/events?after_seq=<seq>`
- [ ] Final verification commands pass:

```bash
cd frontend
pnpm run test -- --run
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Plan Self-Review

- Spec coverage: Tasks 1-9 cover DTO types, fixtures, API base URL, `ApiError`, localStorage token store, auth header injection, JSON envelope parsing, 401 refresh/retry, auth/conversation/run endpoint wrappers, SSE parser, stream client, abort-capable options, public exports, and full frontend verification.
- Scope check: This plan does not modify backend CORS/static mounting, React reducer/hooks, authentication UI, chat UI, deployment, Nginx, or Cloudflare settings.
- Placeholder scan: No unresolved placeholders are present. Every code-changing step includes concrete file content or concrete snippets with exact paths.
- Type consistency: DTO names match the communication foundation spec and current backend schemas: `AuthTokenResponse`, `ConversationResponse`, `SendMessageResponse`, `RunStateResponse`, and `RunEventResponse`.
