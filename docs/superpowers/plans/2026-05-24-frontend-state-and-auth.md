# 前端状态层与认证页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 React 状态 reducer 与核心 hooks 架构，并在其上实现接入真实认证 API 的登录/注册页。

**Architecture:** 单根 `rootReducer` 组合各业务切片；`AppProvider` 用 `useReducer` 持有状态，并装配一个 `onAuthExpired` 接到全局 RESET + abort 的单例 `ApiClient`；State 与 Actions 拆成两个 Context；`useAuthSession` 编排登录/注册/退出副作用；`AuthScreen` 做表单、校验、提交态与中文错误。auth 切片做实，conversation/run/composer/ui 切片只锁类型并处理 RESET。

**Tech Stack:** Vite + React 19 + TypeScript（strict, isolatedModules）+ Vitest + Testing Library + jsdom。已有通信层：`src/api/*`、`src/auth/tokenStore.ts`。

依据 spec：`docs/superpowers/specs/2026-05-24-frontend-state-reducer-and-auth-design.md`。

---

## 通用约定

- **所有命令在仓库根目录运行**，用 `pnpm --dir frontend ...` 指向前端工程（跨 shell，不依赖 `cd`）。
- 单测试文件运行：`pnpm --dir frontend exec vitest run <相对 frontend 的路径>`。
- 类型检查：`pnpm --dir frontend run typecheck`；Lint：`pnpm --dir frontend run lint`。
- 测试文件统一显式 `import { describe, it, expect, vi } from "vitest"`（项目未开 `test.globals`，沿用现有 `App.test.tsx` 风格）。
- 类型导入用 `import type` / 内联 `type`（沿用现有代码风格，满足 `isolatedModules`）。
- 不使用 `any`（`typescript-eslint` recommended 会报错）。

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `frontend/src/auth/state.ts` | auth 切片：`AuthState`、`AuthAction`、`initialAuthState`、`authReducer` | 新建 |
| `frontend/src/conversations/state.ts` | ConversationIndex/Detail 类型 + 初始值 + 处理 RESET（占位） | 新建 |
| `frontend/src/runs/state.ts` | ActiveRun 类型 + 初始值 + 处理 RESET（占位） | 新建 |
| `frontend/src/app/store.ts` | `AppState`、`AppAction`、`initialState`、composer/ui 占位 reducer、`rootReducer` | 新建 |
| `frontend/src/app/store.test.ts` | reducer 单测 | 新建 |
| `frontend/src/conversations/useConversationLoader.ts` | 核心 hook 签名占位（抛未实现） | 新建 |
| `frontend/src/runs/useRunStream.ts` | 核心 hook 签名占位（抛未实现） | 新建 |
| `frontend/src/app/context.ts` | 两个 Context、`useAppState`/`useAppActions`、`Services`/`AuthApi`/`StreamAbortController`/`AppActions` 类型 | 新建 |
| `frontend/src/app/context.test.tsx` | context hooks 单测 | 新建 |
| `frontend/src/app/authExpiry.ts` | `createAuthExpiryHandler`（身份失效 → abort + reset） | 新建 |
| `frontend/src/app/authExpiry.test.ts` | 单测 | 新建 |
| `frontend/src/app/AppProvider.tsx` | Provider 装配（reducer + 单例 client + 两个 Context + 启动恢复） | 新建 |
| `frontend/src/test/appHarness.tsx` | 测试用 fake services + 渲染/wrapper 助手 | 新建 |
| `frontend/src/app/AppProvider.test.tsx` | 启动恢复 + 注入 services | 新建 |
| `frontend/src/auth/useAuthSession.ts` | 登录/注册/退出/提交态/身份编排 | 新建 |
| `frontend/src/auth/useAuthSession.test.tsx` | 单测 | 新建 |
| `frontend/src/auth/authErrorMessages.ts` | `mapAuthError` 中文映射 | 新建 |
| `frontend/src/auth/authErrorMessages.test.ts` | 单测 | 新建 |
| `frontend/src/auth/AuthScreen.tsx` | 登录/注册页 | 新建 |
| `frontend/src/auth/AuthScreen.css` | 认证页样式 | 新建 |
| `frontend/src/auth/AuthScreen.test.tsx` | 组件测试 | 新建 |
| `frontend/src/app/AuthedPlaceholder.tsx` | 临时已登录占位（第 6 步替换） | 新建 |
| `frontend/src/app/App.tsx` | 认证门 | 改写 |
| `frontend/src/app/App.test.tsx` | 认证门测试 | 改写 |
| `frontend/src/main.tsx` | 用 `<AppProvider>` 包裹 `<App/>` | 改写 |

> **循环依赖说明：** `store.ts` 用值导入各 slice reducer；slice 文件用 `import type { AppAction } from "../app/store"`（类型导入会被擦除）。运行时依赖只有 `store → slice` 单向，无运行时环。这是本计划刻意采用的结构。

---

### Task 1: 状态树与 rootReducer

**Files:**
- Create: `frontend/src/auth/state.ts`
- Create: `frontend/src/conversations/state.ts`
- Create: `frontend/src/runs/state.ts`
- Create: `frontend/src/app/store.ts`
- Test: `frontend/src/app/store.test.ts`

- [ ] **Step 1: 写失败测试**

`frontend/src/app/store.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createAuthSession } from "../auth/tokenStore";
import { initialState, rootReducer } from "./store";

describe("rootReducer auth slice", () => {
  it("marks bootstrapped on auth/restored with a session", () => {
    const session = createAuthSession(authTokenResponse);
    const next = rootReducer(initialState, { type: "auth/restored", session });

    expect(next.auth.session).toEqual(session);
    expect(next.auth.bootstrapped).toBe(true);
  });

  it("marks bootstrapped on auth/restored with no session", () => {
    const next = rootReducer(initialState, { type: "auth/restored", session: null });

    expect(next.auth.session).toBeNull();
    expect(next.auth.bootstrapped).toBe(true);
  });

  it("toggles submitting status", () => {
    const submitting = rootReducer(initialState, { type: "auth/submitStarted" });
    expect(submitting.auth.status).toBe("submitting");

    const failed = rootReducer(submitting, { type: "auth/submitFailed" });
    expect(failed.auth.status).toBe("idle");
  });

  it("stores the session and clears submitting on auth/loggedIn", () => {
    const session = createAuthSession(authTokenResponse);
    const submitting = rootReducer(initialState, { type: "auth/submitStarted" });
    const next = rootReducer(submitting, { type: "auth/loggedIn", session });

    expect(next.auth.session).toEqual(session);
    expect(next.auth.status).toBe("idle");
  });
});

describe("rootReducer app/reset", () => {
  it("clears every slice but keeps bootstrapped true", () => {
    const session = createAuthSession(authTokenResponse);
    const dirty = rootReducer(initialState, { type: "auth/loggedIn", session });

    const reset = rootReducer(dirty, { type: "app/reset" });

    expect(reset.auth.session).toBeNull();
    expect(reset.auth.status).toBe("idle");
    expect(reset.auth.bootstrapped).toBe(true);
    expect(reset.conversationIndex).toEqual(initialState.conversationIndex);
    expect(reset.conversationDetail).toEqual(initialState.conversationDetail);
    expect(reset.activeRun).toBeNull();
    expect(reset.composer).toEqual(initialState.composer);
    expect(reset.ui).toEqual(initialState.ui);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/app/store.test.ts`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: 实现 auth 切片**

`frontend/src/auth/state.ts`：

```ts
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
```

- [ ] **Step 4: 实现 conversations 占位切片**

`frontend/src/conversations/state.ts`：

```ts
import type { ConversationResponse, MessageResponse } from "../api/types";
import type { AppAction } from "../app/store";

export type ConversationIndexState = {
  items: ConversationResponse[];
  selectedId: number | null;
  draftId: number | null;
  pendingTitleIds: number[];
  status: "idle" | "loading" | "error";
};

export const initialConversationIndexState: ConversationIndexState = {
  items: [],
  selectedId: null,
  draftId: null,
  pendingTitleIds: [],
  status: "idle",
};

export type ConversationDetailState = {
  conversation: ConversationResponse | null;
  messages: MessageResponse[];
  status: "idle" | "loading" | "ready" | "forbidden";
};

export const initialConversationDetailState: ConversationDetailState = {
  conversation: null,
  messages: [],
  status: "idle",
};

// Placeholder reducers: only RESET is handled now; feature actions land in later steps.
export function conversationIndexReducer(
  state: ConversationIndexState,
  action: AppAction,
): ConversationIndexState {
  if (action.type === "app/reset") return initialConversationIndexState;
  return state;
}

export function conversationDetailReducer(
  state: ConversationDetailState,
  action: AppAction,
): ConversationDetailState {
  if (action.type === "app/reset") return initialConversationDetailState;
  return state;
}
```

- [ ] **Step 5: 实现 runs 占位切片**

`frontend/src/runs/state.ts`：

```ts
import type { RunStatus } from "../api/types";
import type { AppAction } from "../app/store";

// AbortController is intentionally NOT stored in the reducer (not serializable).
// useRunStream (later step) keeps it in a ref; only serializable state lives here.
export type ActiveRunState = {
  runId: number;
  conversationId: number;
  latestSeq: number;
  draftText: string;
  draftReasoning: string;
  status: RunStatus;
  cancelRequested: boolean;
} | null;

export const initialActiveRunState: ActiveRunState = null;

export function activeRunReducer(
  state: ActiveRunState,
  action: AppAction,
): ActiveRunState {
  if (action.type === "app/reset") return initialActiveRunState;
  return state;
}
```

- [ ] **Step 6: 实现 store.ts（组合根 reducer）**

`frontend/src/app/store.ts`：

```ts
import {
  conversationDetailReducer,
  conversationIndexReducer,
  initialConversationDetailState,
  initialConversationIndexState,
  type ConversationDetailState,
  type ConversationIndexState,
} from "../conversations/state";
import { authReducer, initialAuthState, type AuthAction, type AuthState } from "../auth/state";
import { activeRunReducer, initialActiveRunState, type ActiveRunState } from "../runs/state";

export type ComposerState = { input: string; isComposing: boolean };
export type UiState = { mobileSidebarOpen: boolean };

const initialComposerState: ComposerState = { input: "", isComposing: false };
const initialUiState: UiState = { mobileSidebarOpen: false };

export type AppState = {
  auth: AuthState;
  conversationIndex: ConversationIndexState;
  conversationDetail: ConversationDetailState;
  activeRun: ActiveRunState;
  composer: ComposerState;
  ui: UiState;
};

export type AppResetAction = { type: "app/reset" };
export type AppAction = AuthAction | AppResetAction;

export const initialState: AppState = {
  auth: initialAuthState,
  conversationIndex: initialConversationIndexState,
  conversationDetail: initialConversationDetailState,
  activeRun: initialActiveRunState,
  composer: initialComposerState,
  ui: initialUiState,
};

function composerReducer(state: ComposerState, action: AppAction): ComposerState {
  if (action.type === "app/reset") return initialComposerState;
  return state;
}

function uiReducer(state: UiState, action: AppAction): UiState {
  if (action.type === "app/reset") return initialUiState;
  return state;
}

export function rootReducer(state: AppState, action: AppAction): AppState {
  return {
    auth: authReducer(state.auth, action),
    conversationIndex: conversationIndexReducer(state.conversationIndex, action),
    conversationDetail: conversationDetailReducer(state.conversationDetail, action),
    activeRun: activeRunReducer(state.activeRun, action),
    composer: composerReducer(state.composer, action),
    ui: uiReducer(state.ui, action),
  };
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/app/store.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 8: 类型检查**

Run: `pnpm --dir frontend run typecheck`
Expected: 无错误。

- [ ] **Step 9: 提交**

```bash
git add frontend/src/auth/state.ts frontend/src/conversations/state.ts frontend/src/runs/state.ts frontend/src/app/store.ts frontend/src/app/store.test.ts
git commit -m "feat(frontend): add app state tree and root reducer"
```

---

### Task 2: 核心 hook 签名占位

`useConversationLoader` / `useRunStream` 在后续步骤实现，本步只保留命名与签名（spec 要求的「签名占位」）。这两个文件是**有意的占位**，不写测试。

**Files:**
- Create: `frontend/src/conversations/useConversationLoader.ts`
- Create: `frontend/src/runs/useRunStream.ts`

- [ ] **Step 1: 创建 useConversationLoader 占位**

`frontend/src/conversations/useConversationLoader.ts`：

```ts
// Signature placeholder. Implemented in the conversation-loading refactor step.
export function useConversationLoader(): never {
  throw new Error("useConversationLoader is implemented in a later refactor step");
}
```

- [ ] **Step 2: 创建 useRunStream 占位**

`frontend/src/runs/useRunStream.ts`：

```ts
// Signature placeholder. Implemented in the SSE streaming refactor step.
export function useRunStream(): never {
  throw new Error("useRunStream is implemented in a later refactor step");
}
```

- [ ] **Step 3: 类型检查 + Lint**

Run: `pnpm --dir frontend run typecheck`
Run: `pnpm --dir frontend run lint`
Expected: 均无错误。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/conversations/useConversationLoader.ts frontend/src/runs/useRunStream.ts
git commit -m "feat(frontend): reserve core hook signatures"
```

---

### Task 3: Context 与读取 hook

**Files:**
- Create: `frontend/src/app/context.ts`
- Test: `frontend/src/app/context.test.tsx`

- [ ] **Step 1: 写失败测试**

`frontend/src/app/context.test.tsx`：

```tsx
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { initialState } from "./store";
import {
  ActionsContext,
  StateContext,
  useAppActions,
  useAppState,
  type AppActions,
} from "./context";

function StateProbe() {
  const state = useAppState();
  return <span>bootstrapped:{String(state.auth.bootstrapped)}</span>;
}

describe("useAppState", () => {
  it("throws outside the provider", () => {
    expect(() => renderHook(() => useAppState())).toThrow(/AppProvider/);
  });

  it("returns the provided state", () => {
    render(
      <StateContext.Provider value={initialState}>
        <StateProbe />
      </StateContext.Provider>,
    );
    expect(screen.getByText("bootstrapped:false")).toBeInTheDocument();
  });
});

describe("useAppActions", () => {
  it("throws outside the provider", () => {
    expect(() => renderHook(() => useAppActions())).toThrow(/AppProvider/);
  });

  it("returns the provided actions", () => {
    const actions: AppActions = {
      dispatch: vi.fn(),
      services: { authApi: {} as AppActions["services"]["authApi"] },
      streamAbort: { register: vi.fn(), abort: vi.fn() },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    );
    const { result } = renderHook(() => useAppActions(), { wrapper });
    expect(result.current).toBe(actions);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/app/context.test.tsx`
Expected: FAIL — `Cannot find module './context'`.

- [ ] **Step 3: 实现 context.ts**

`frontend/src/app/context.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/app/context.test.tsx`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/app/context.ts frontend/src/app/context.test.tsx
git commit -m "feat(frontend): add app state and actions contexts"
```

---

### Task 4: 身份失效处理器

**Files:**
- Create: `frontend/src/app/authExpiry.ts`
- Test: `frontend/src/app/authExpiry.test.ts`

- [ ] **Step 1: 写失败测试**

`frontend/src/app/authExpiry.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { createAuthExpiryHandler } from "./authExpiry";

describe("createAuthExpiryHandler", () => {
  it("aborts the active stream then dispatches app/reset", () => {
    const calls: string[] = [];
    const abort = vi.fn(() => calls.push("abort"));
    const dispatch = vi.fn(() => calls.push("dispatch"));

    const handler = createAuthExpiryHandler({ dispatch, abort });
    handler();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "app/reset" });
    expect(calls).toEqual(["abort", "dispatch"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/app/authExpiry.test.ts`
Expected: FAIL — `Cannot find module './authExpiry'`.

- [ ] **Step 3: 实现 authExpiry.ts**

`frontend/src/app/authExpiry.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/app/authExpiry.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/app/authExpiry.ts frontend/src/app/authExpiry.test.ts
git commit -m "feat(frontend): add auth expiry reset handler"
```

---

### Task 5: AppProvider 与测试 harness

**Files:**
- Create: `frontend/src/app/AppProvider.tsx`
- Create: `frontend/src/test/appHarness.tsx`
- Test: `frontend/src/app/AppProvider.test.tsx`

> **实现说明：** spec 的伪代码用 ref 转发 dispatch；实际 `useReducer` 返回的 `dispatch` 在整个生命周期稳定，可直接闭包捕获，无需 ref。只有「进行中 stream 的 abort」需要 ref，因为它由后续步骤的 `useRunStream` 注册（`streamAbort.register`）。

- [ ] **Step 1: 写测试 harness（无测试，供后续测试复用）**

`frontend/src/test/appHarness.tsx`：

```tsx
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { AppProvider } from "../app/AppProvider";
import type { AuthApi, Services } from "../app/context";
import { authTokenResponse } from "./apiFixtures";

export function createFakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: async () => authTokenResponse,
    login: async () => authTokenResponse,
    refresh: async () => authTokenResponse,
    logout: async () => ({ status: "ok" }),
    ...overrides,
  };
}

export function createFakeServices(authApi: Partial<AuthApi> = {}): Services {
  return { authApi: createFakeAuthApi(authApi) };
}

export function makeWrapper(services: Services) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AppProvider services={services}>{children}</AppProvider>;
  };
}

export function renderWithApp(
  ui: ReactElement,
  services: Services,
  options?: RenderOptions,
) {
  return render(<AppProvider services={services}>{ui}</AppProvider>, options);
}
```

- [ ] **Step 2: 写失败测试**

`frontend/src/app/AppProvider.test.tsx`：

```tsx
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { useAppState } from "./context";

function AuthProbe() {
  const { auth } = useAppState();
  return (
    <div>
      <span>bootstrapped:{String(auth.bootstrapped)}</span>
      <span>user:{auth.session?.user.username ?? "none"}</span>
    </div>
  );
}

describe("AppProvider", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("restores no session when storage is empty", async () => {
    renderWithApp(<AuthProbe />, createFakeServices());

    expect(await screen.findByText("bootstrapped:true")).toBeInTheDocument();
    expect(screen.getByText("user:none")).toBeInTheDocument();
  });

  it("restores a persisted session on mount", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<AuthProbe />, createFakeServices());

    expect(await screen.findByText("user:alice")).toBeInTheDocument();
    expect(screen.getByText("bootstrapped:true")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/app/AppProvider.test.tsx`
Expected: FAIL — `Cannot find module '../app/AppProvider'`.

- [ ] **Step 4: 实现 AppProvider.tsx**

`frontend/src/app/AppProvider.tsx`：

```tsx
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { createAuthApi } from "../api/auth";
import { ApiClient } from "../api/client";
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
    return { authApi: createAuthApi(client) };
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/app/AppProvider.test.tsx`
Expected: PASS（2 个用例）。

- [ ] **Step 6: 类型检查 + Lint**

Run: `pnpm --dir frontend run typecheck`
Run: `pnpm --dir frontend run lint`
Expected: 均无错误（注意 `useEffect([])` 中 `dispatch` 稳定，`react-hooks/exhaustive-deps` 不会报）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/app/AppProvider.tsx frontend/src/test/appHarness.tsx frontend/src/app/AppProvider.test.tsx
git commit -m "feat(frontend): add AppProvider with client wiring and boot restore"
```

---

### Task 6: useAuthSession

**Files:**
- Create: `frontend/src/auth/useAuthSession.ts`
- Test: `frontend/src/auth/useAuthSession.test.tsx`

> **与 spec 的偏差（更干净的分层）：** spec 伪代码让 hook `throw mapAuthError(...)`，但 `mapAuthError` 返回的是视图对象、不是 `Error`。本计划让 `useAuthSession` **重新抛出原始错误**，由 `AuthScreen` 调 `mapAuthError` 做展示映射，保持 hook 与 UI 解耦。

- [ ] **Step 1: 写失败测试**

`frontend/src/auth/useAuthSession.test.tsx`：

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { tokenStore } from "./tokenStore";
import { useAuthSession } from "./useAuthSession";

describe("useAuthSession", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("logs in: calls api, persists token, marks authenticated", async () => {
    const login = vi.fn(async () => authTokenResponse);
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ login })),
    });

    await act(async () => {
      await result.current.login({ identifier: "alice", password: "password123" });
    });

    expect(login).toHaveBeenCalledWith({ identifier: "alice", password: "password123" });
    expect(tokenStore.getAccessToken()).toBe(authTokenResponse.access_token);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.username).toBe("alice");
    expect(result.current.isSubmitting).toBe(false);
  });

  it("login failure: clears submitting and rethrows", async () => {
    const error = new ApiError({ status: 401, message: "登录状态已失效，请重新登录" });
    const login = vi.fn(async () => {
      throw error;
    });
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ login })),
    });

    await act(async () => {
      await expect(
        result.current.login({ identifier: "alice", password: "password123" }),
      ).rejects.toBe(error);
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isSubmitting).toBe(false);
  });

  it("registers: persists token and marks authenticated", async () => {
    const register = vi.fn(async () => authTokenResponse);
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ register })),
    });

    await act(async () => {
      await result.current.register({
        username: "alice",
        email: "alice@example.com",
        password: "password123",
      });
    });

    expect(register).toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("logout: calls api, clears token, resets state", async () => {
    const logout = vi.fn(async () => ({ status: "ok" }));
    const { result } = renderHook(() => useAuthSession(), {
      wrapper: makeWrapper(createFakeServices({ logout })),
    });

    await act(async () => {
      await result.current.login({ identifier: "alice", password: "password123" });
    });
    await act(async () => {
      await result.current.logout();
    });

    expect(logout).toHaveBeenCalledWith(authTokenResponse.refresh_token);
    expect(tokenStore.read()).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/auth/useAuthSession.test.tsx`
Expected: FAIL — `Cannot find module './useAuthSession'`.

- [ ] **Step 3: 实现 useAuthSession.ts**

`frontend/src/auth/useAuthSession.ts`：

```ts
import { useCallback } from "react";

import type { LoginRequest, RegisterRequest } from "../api/auth";
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

  return {
    session: auth.session,
    user: auth.session?.user ?? null,
    isAuthenticated: auth.session !== null,
    isSubmitting: auth.status === "submitting",
    bootstrapped: auth.bootstrapped,
    login,
    register,
    logout,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/auth/useAuthSession.test.tsx`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/auth/useAuthSession.ts frontend/src/auth/useAuthSession.test.tsx
git commit -m "feat(frontend): add useAuthSession orchestration hook"
```

---

### Task 7: 认证错误中文映射

**Files:**
- Create: `frontend/src/auth/authErrorMessages.ts`
- Test: `frontend/src/auth/authErrorMessages.test.ts`

- [ ] **Step 1: 写失败测试**

`frontend/src/auth/authErrorMessages.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { ApiError } from "../api/errors";
import { mapAuthError } from "./authErrorMessages";

describe("mapAuthError", () => {
  it("maps login 401 to a form message", () => {
    const view = mapAuthError(new ApiError({ status: 401 }), "login");
    expect(view.formMessage).toBe("用户名或密码错误");
    expect(view.fieldErrors).toBeUndefined();
  });

  it("maps register 409 username conflict to a field error", () => {
    const error = new ApiError({ status: 409, detail: "Username is already registered" });
    const view = mapAuthError(error, "register");
    expect(view.fieldErrors?.username).toBe("该用户名已被注册");
  });

  it("maps register 409 email conflict to a field error", () => {
    const error = new ApiError({ status: 409, detail: "Email is already registered" });
    const view = mapAuthError(error, "register");
    expect(view.fieldErrors?.email).toBe("该邮箱已被注册");
  });

  it("maps 422 to a generic form message", () => {
    const view = mapAuthError(new ApiError({ status: 422 }), "register");
    expect(view.formMessage).toBe("提交内容不符合要求，请检查后重试");
  });

  it("ignores aborted requests", () => {
    const view = mapAuthError(new ApiError({ status: 0, isAbort: true }), "login");
    expect(view).toEqual({});
  });

  it("falls back to the api error message", () => {
    const view = mapAuthError(new ApiError({ status: 500 }), "login");
    expect(view.formMessage).toBe("服务暂时不可用，请稍后重试");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/auth/authErrorMessages.test.ts`
Expected: FAIL — `Cannot find module './authErrorMessages'`.

- [ ] **Step 3: 实现 authErrorMessages.ts**

`frontend/src/auth/authErrorMessages.ts`：

```ts
import { toApiError } from "../api/errors";

export type AuthMode = "login" | "register";

export type AuthFieldErrors = Partial<
  Record<"username" | "email" | "identifier" | "password", string>
>;

export type AuthErrorView = {
  fieldErrors?: AuthFieldErrors;
  formMessage?: string;
};

export function mapAuthError(error: unknown, mode: AuthMode): AuthErrorView {
  const apiError = toApiError(error);

  if (apiError.isAbort) {
    return {};
  }

  if (mode === "login" && apiError.status === 401) {
    return { formMessage: "用户名或密码错误" };
  }

  if (mode === "register" && apiError.status === 409) {
    const detail = typeof apiError.detail === "string" ? apiError.detail : "";
    if (detail.includes("Username")) {
      return { fieldErrors: { username: "该用户名已被注册" } };
    }
    if (detail.includes("Email")) {
      return { fieldErrors: { email: "该邮箱已被注册" } };
    }
  }

  if (apiError.status === 422) {
    return { formMessage: "提交内容不符合要求，请检查后重试" };
  }

  return { formMessage: apiError.message };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/auth/authErrorMessages.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/auth/authErrorMessages.ts frontend/src/auth/authErrorMessages.test.ts
git commit -m "feat(frontend): add chinese auth error mapping"
```

---

### Task 8: AuthScreen 认证页

**Files:**
- Create: `frontend/src/auth/AuthScreen.tsx`
- Create: `frontend/src/auth/AuthScreen.css`
- Test: `frontend/src/auth/AuthScreen.test.tsx`

- [ ] **Step 1: 写失败测试**

`frontend/src/auth/AuthScreen.test.tsx`：

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { AuthScreen } from "./AuthScreen";

describe("AuthScreen", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows login fields by default and register fields after switching", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    expect(screen.getByLabelText("用户名或邮箱")).toBeInTheDocument();
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "注册" }));

    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
  });

  it("shows field errors when submitting an empty login form", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => authTokenResponse);
    renderWithApp(<AuthScreen />, createFakeServices({ login }));

    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(screen.getByText("请输入用户名或邮箱")).toBeInTheDocument();
    expect(screen.getByText("密码长度需为 8–128 位")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects an invalid email on register", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    await user.click(screen.getByRole("tab", { name: "注册" }));
    await user.type(screen.getByLabelText("用户名"), "alice");
    await user.type(screen.getByLabelText("邮箱"), "not-an-email");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "注册" }));

    expect(screen.getByText("请输入有效的邮箱地址")).toBeInTheDocument();
  });

  it("submits a valid login with trimmed values", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => authTokenResponse);
    renderWithApp(<AuthScreen />, createFakeServices({ login }));

    await user.type(screen.getByLabelText("用户名或邮箱"), "  alice  ");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(login).toHaveBeenCalledWith({ identifier: "alice", password: "password123" });
  });

  it("shows a form error message on login 401", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => {
      throw new ApiError({ status: 401 });
    });
    renderWithApp(<AuthScreen />, createFakeServices({ login }));

    await user.type(screen.getByLabelText("用户名或邮箱"), "alice");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
  });

  it("shows a username field error on register 409", async () => {
    const user = userEvent.setup();
    const register = vi.fn(async () => {
      throw new ApiError({ status: 409, detail: "Username is already registered" });
    });
    renderWithApp(<AuthScreen />, createFakeServices({ register }));

    await user.click(screen.getByRole("tab", { name: "注册" }));
    await user.type(screen.getByLabelText("用户名"), "alice");
    await user.type(screen.getByLabelText("邮箱"), "alice@example.com");
    await user.type(screen.getByLabelText("密码"), "password123");
    await user.click(screen.getByRole("button", { name: "注册" }));

    expect(await screen.findByText("该用户名已被注册")).toBeInTheDocument();
  });

  it("clears errors when switching modes", async () => {
    const user = userEvent.setup();
    renderWithApp(<AuthScreen />, createFakeServices());

    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(screen.getByText("请输入用户名或邮箱")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "注册" }));
    expect(screen.queryByText("请输入用户名或邮箱")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/auth/AuthScreen.test.tsx`
Expected: FAIL — `Cannot find module './AuthScreen'`.

- [ ] **Step 3: 实现 AuthScreen.tsx**

`frontend/src/auth/AuthScreen.tsx`：

```tsx
import { useState, type FormEvent } from "react";

import { mapAuthError, type AuthFieldErrors, type AuthMode } from "./authErrorMessages";
import { useAuthSession } from "./useAuthSession";
import "./AuthScreen.css";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthScreen() {
  const { login, register, isSubmitting } = useAuthSession();
  const [mode, setMode] = useState<AuthMode>("login");
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formMessage, setFormMessage] = useState<string | undefined>(undefined);

  function switchMode(next: AuthMode) {
    if (next === mode) return;
    setMode(next);
    setFieldErrors({});
    setFormMessage(undefined);
  }

  function validate(): AuthFieldErrors {
    const errors: AuthFieldErrors = {};
    if (mode === "register") {
      const name = username.trim();
      if (name.length < 1 || name.length > 50) {
        errors.username = "请输入 1–50 个字符的用户名";
      }
      if (!EMAIL_PATTERN.test(email.trim())) {
        errors.email = "请输入有效的邮箱地址";
      }
    } else if (identifier.trim().length < 1) {
      errors.identifier = "请输入用户名或邮箱";
    }
    if (password.length < 8 || password.length > 128) {
      errors.password = "密码长度需为 8–128 位";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setFormMessage(undefined);
      return;
    }

    setFieldErrors({});
    setFormMessage(undefined);

    try {
      if (mode === "register") {
        await register({ username: username.trim(), email: email.trim(), password });
      } else {
        await login({ identifier: identifier.trim(), password });
      }
    } catch (error) {
      const view = mapAuthError(error, mode);
      setFieldErrors(view.fieldErrors ?? {});
      setFormMessage(view.formMessage);
    }
  }

  const submitLabel = isSubmitting
    ? mode === "register"
      ? "注册中…"
      : "登录中…"
    : mode === "register"
      ? "注册"
      : "登录";

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1 className="auth-title">iChat</h1>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "auth-tab auth-tab--active" : "auth-tab"}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "auth-tab auth-tab--active" : "auth-tab"}
            onClick={() => switchMode("register")}
          >
            注册
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          {mode === "register" ? (
            <>
              <div className="auth-field">
                <label htmlFor="auth-username">用户名</label>
                <input
                  id="auth-username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                {fieldErrors.username ? (
                  <span className="auth-field-error">{fieldErrors.username}</span>
                ) : null}
              </div>
              <div className="auth-field">
                <label htmlFor="auth-email">邮箱</label>
                <input
                  id="auth-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {fieldErrors.email ? (
                  <span className="auth-field-error">{fieldErrors.email}</span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="auth-field">
              <label htmlFor="auth-identifier">用户名或邮箱</label>
              <input
                id="auth-identifier"
                name="identifier"
                autoComplete="username"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
              />
              {fieldErrors.identifier ? (
                <span className="auth-field-error">{fieldErrors.identifier}</span>
              ) : null}
            </div>
          )}

          <div className="auth-field">
            <label htmlFor="auth-password">密码</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {fieldErrors.password ? (
              <span className="auth-field-error">{fieldErrors.password}</span>
            ) : null}
          </div>

          {formMessage ? (
            <p className="auth-form-error" role="alert">
              {formMessage}
            </p>
          ) : null}

          <button type="submit" className="auth-submit" disabled={isSubmitting}>
            {submitLabel}
          </button>
        </form>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: 实现 AuthScreen.css**

`frontend/src/auth/AuthScreen.css`：

```css
.auth-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
}

.auth-card {
  width: min(100%, 420px);
  border: 1px solid #e5e5e0;
  border-radius: 12px;
  background: #ffffff;
  padding: 32px;
  box-shadow: 0 20px 55px rgb(36 36 30 / 8%);
}

.auth-title {
  margin: 0 0 24px;
  color: #171717;
  font-size: 1.75rem;
  text-align: center;
}

.auth-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 24px;
  padding: 4px;
  border-radius: 8px;
  background: #f3f3f0;
}

.auth-tab {
  flex: 1;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #71716a;
  cursor: pointer;
}

.auth-tab--active {
  background: #ffffff;
  color: #171717;
  box-shadow: 0 1px 3px rgb(36 36 30 / 12%);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auth-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auth-field label {
  color: #4a4a45;
  font-size: 0.875rem;
}

.auth-field input {
  padding: 10px 12px;
  border: 1px solid #d6d6cf;
  border-radius: 8px;
  background: #fbfbfa;
  color: #262626;
}

.auth-field input:focus {
  border-color: #8a8a82;
  outline: none;
}

.auth-field-error {
  color: #b42318;
  font-size: 0.8125rem;
}

.auth-form-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fef3f2;
  color: #b42318;
  font-size: 0.875rem;
}

.auth-submit {
  padding: 11px 16px;
  border: none;
  border-radius: 8px;
  background: #171717;
  color: #ffffff;
  cursor: pointer;
}

.auth-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/auth/AuthScreen.test.tsx`
Expected: PASS（7 个用例）。

- [ ] **Step 6: 类型检查 + Lint**

Run: `pnpm --dir frontend run typecheck`
Run: `pnpm --dir frontend run lint`
Expected: 均无错误。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/auth/AuthScreen.tsx frontend/src/auth/AuthScreen.css frontend/src/auth/AuthScreen.test.tsx
git commit -m "feat(frontend): add auth screen with login and register"
```

---

### Task 9: 认证门 + 已登录占位 + 入口装配

**Files:**
- Create: `frontend/src/app/AuthedPlaceholder.tsx`
- Modify: `frontend/src/app/App.tsx`（整文件替换）
- Modify: `frontend/src/app/App.test.tsx`（整文件替换）
- Modify: `frontend/src/main.tsx`（整文件替换）

- [ ] **Step 1: 写失败测试（替换旧 App.test.tsx）**

`frontend/src/app/App.test.tsx`（整文件替换为）：

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authTokenResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { createAuthSession, tokenStore } from "../auth/tokenStore";
import { App } from "./App";

describe("App auth gate", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows the auth screen when unauthenticated", async () => {
    renderWithApp(<App />, createFakeServices());

    expect(await screen.findByRole("tab", { name: "登录" })).toBeInTheDocument();
  });

  it("shows the authenticated placeholder when a session is restored", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    expect(await screen.findByText("已登录：alice")).toBeInTheDocument();
  });

  it("returns to the auth screen after logout", async () => {
    const user = userEvent.setup();
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    await user.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("tab", { name: "登录" })).toBeInTheDocument();
    expect(tokenStore.read()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir frontend exec vitest run src/app/App.test.tsx`
Expected: FAIL — `Cannot find module './AuthedPlaceholder'`（App 尚未改）或断言失败。

- [ ] **Step 3: 实现 AuthedPlaceholder.tsx**

`frontend/src/app/AuthedPlaceholder.tsx`：

```tsx
import { useAuthSession } from "../auth/useAuthSession";

// Temporary authenticated view. Replaced by the chat shell in the next step.
export function AuthedPlaceholder() {
  const { user, logout } = useAuthSession();

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1 className="auth-title">iChat</h1>
        <p>已登录：{user?.username}</p>
        <p>聊天界面将在后续步骤接入。</p>
        <button type="button" className="auth-submit" onClick={() => void logout()}>
          退出登录
        </button>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: 改写 App.tsx**

`frontend/src/app/App.tsx`（整文件替换为）：

```tsx
import { AuthScreen } from "../auth/AuthScreen";
import { useAuthSession } from "../auth/useAuthSession";
import { AuthedPlaceholder } from "./AuthedPlaceholder";

export function App() {
  const { bootstrapped, isAuthenticated } = useAuthSession();

  if (!bootstrapped) {
    return null;
  }

  return isAuthenticated ? <AuthedPlaceholder /> : <AuthScreen />;
}
```

> `AuthedPlaceholder.tsx` 复用 `AuthScreen.css` 的 `.auth-shell`/`.auth-card`/`.auth-title`/`.auth-submit`。该 CSS 已被 `AuthScreen` import，运行时会被注入；占位组件无需再 import。

- [ ] **Step 5: 改写 main.tsx**

`frontend/src/main.tsx`（整文件替换为）：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { AppProvider } from "./app/AppProvider";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/app/App.test.tsx`
Expected: PASS（3 个用例）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/app/AuthedPlaceholder.tsx frontend/src/app/App.tsx frontend/src/app/App.test.tsx frontend/src/main.tsx
git commit -m "feat(frontend): wire auth gate and app provider entry"
```

---

### Task 10: 全量验证

**Files:** 无新增，仅运行完整校验。

- [ ] **Step 1: 全量测试**

Run: `pnpm --dir frontend exec vitest run`
Expected: 所有测试文件通过（含已有通信层测试 + 本次新增）。

- [ ] **Step 2: 类型检查**

Run: `pnpm --dir frontend run typecheck`
Expected: 无错误。

- [ ] **Step 3: Lint**

Run: `pnpm --dir frontend run lint`
Expected: 无错误、无 warning。

- [ ] **Step 4: 生产构建**

Run: `pnpm --dir frontend run build`
Expected: `tsc -b` 通过 + Vite 构建成功，产物输出到 `frontend/dist/`。

- [ ] **Step 5: （可选）本地跨域 smoke**

启动后端：`uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`
启动前端：`pnpm --dir frontend dev`（需 `frontend/.env` 或环境含 `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1`，且后端 `CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`）
手动验证：注册 → 自动登录 → 刷新保持登录 → 退出回到认证页。

- [ ] **Step 6: 无新增文件改动则无需提交**（前几个任务已分别提交）。

---

## Self-Review

**1. Spec coverage（逐节核对）**

- 状态容器形态（方案 A，State/Dispatch 拆 Context）→ Task 3 + Task 5。✓
- 整棵状态树类型锁定 → Task 1（六切片类型 + initialState）。✓
- 全局 RESET 清空所有切片、auth.bootstrapped 保持 true → Task 1 测试覆盖。✓
- AbortController 不进 reducer → Task 1 `runs/state.ts` 注释 + ActiveRunState 不含该字段。✓
- 单例 ApiClient + onAuthExpired 接 reset + abort → Task 4（处理器）+ Task 5（装配）。✓
- token 事实源 tokenStore / reducer 渲染镜像，login/register/logout/restore 同步 → Task 5（restore）+ Task 6（login/register/logout）。✓
- useAuthSession 编排 + 提交态 + best-effort logout → Task 6。✓
- 占位 hook 签名 → Task 2。✓
- AuthScreen：单卡片、登录/注册切换、字段校验、提交态、回车提交、字段级 + 表单级中文错误 → Task 8（含表单 `onSubmit` 支持 Enter）。✓
- 中文错误映射（401/409 用户名/409 邮箱/422/abort/兜底）→ Task 7。✓
- 认证门 + 最小已登录占位 → Task 9。✓
- 入口 AppProvider 包裹 → Task 9（main.tsx）。✓
- 测试矩阵（reducer / useAuthSession / mapAuthError / AppProvider / AuthScreen / App gate）→ Task 1/6/7/5/8/9。✓
- 验收标准（lint/typecheck/test/build）→ Task 10。✓

**2. Placeholder scan**：计划内无 “TBD/TODO/稍后实现/类似 Task N” 等占位；每个代码步骤都给出完整代码。`useConversationLoader`/`useRunStream` 是 spec 明确要求的「签名占位」，已在 Task 2 给出完整 stub 实现并说明无需测试，非计划占位。✓

**3. Type consistency（跨任务核对）**

- `AppAction` = `AuthAction | AppResetAction`（Task 1）；`authReducer`/各占位 reducer 参数均为 `AppAction`（Task 1）。✓
- `AppActions` = `{ dispatch, services, streamAbort }`（Task 3）；`AppProvider` 提供同形（Task 5）；`useAuthSession` 解构同名（Task 6）。✓
- `Services.authApi: AuthApi`（Task 3）；`createFakeAuthApi` 返回 `AuthApi`、四个方法签名一致（Task 5）；`createAuthApi(client)` 结构兼容 `AuthApi`（Task 5 装配）。✓
- `AuthFieldErrors`/`AuthMode`/`AuthErrorView` 在 `authErrorMessages.ts` 定义（Task 7），`AuthScreen` 直接 import 使用（Task 8）。✓
- `createAuthSession`/`tokenStore`（已有模块）签名与调用一致（Task 5/6）。✓
- `streamAbort.register`/`streamAbort.abort`（Task 3 类型）在 Task 5 实现、Task 6 logout 调用 `abort`。✓
- `auth/restored` payload 字段名 `session`（Task 1 定义、Task 5 dispatch）。✓

无不一致项。

---

## 关联文档

- 本计划对应 spec：[`../specs/2026-05-24-frontend-state-reducer-and-auth-design.md`](../specs/2026-05-24-frontend-state-reducer-and-auth-design.md)
- 重构总设计：[`../specs/2026-05-24-frontend-react-rebuild-design.md`](../specs/2026-05-24-frontend-react-rebuild-design.md)
- 通信基础层交接：[`../../handover/frontend/2026-05-24-frontend-communication-foundation.md`](../../handover/frontend/2026-05-24-frontend-communication-foundation.md)
