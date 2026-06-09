# 前端发送消息与 SSE 基础流式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 React 前端打通「发送消息 → SSE 流式渲染思考与正文 → run 成功后服务端消息接管」的最小闭环（步骤 8）。

**Architecture:** 方案 A——`conversationDetail.messages` 保持服务端事实源；流式草稿由独立的 `activeRun` 切片驱动，渲染为挂在消息列表之后的临时 `StreamingMessage`；`useRunStream` 消费 `runApi.streamEvents` 并派发 delta/terminal，成功后重拉 detail+list 替换临时气泡。失败/取消最小处理（保留 partial + 状态文字 + 恢复输入）。停止/取消按钮、刷新恢复、编辑/重生、自动标题、Toast 留给后续步骤。

**Tech Stack:** React 18 + TypeScript + Vitest + Testing Library + `@testing-library/user-event`。所有测试通过 `createFakeServices` 注入 fake，不触达真实 HTTP/SSE。

**Spec:** `docs/superpowers/specs/2026-06-09-frontend-send-and-sse-streaming-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `frontend/src/api/runs.ts` | run API 工厂 | Modify：导出 `RunApi` 类型别名 |
| `frontend/src/app/context.ts` | Services 类型 | Modify：`Services` 增加 `runApi` |
| `frontend/src/app/AppProvider.tsx` | provider 装配 | Modify：真实分支装配 `runApi` |
| `frontend/src/test/apiFixtures.ts` | 测试 fixtures | Modify：新增 `reasoningDeltaEvent`、`failedEvent` |
| `frontend/src/test/appHarness.tsx` | 测试装配 | Modify：`createFakeRunApi`、`fakeStream`、`createFakeServices` 第三参数 |
| `frontend/src/runs/state.ts` | active run 切片 | Modify：做实 reducer + action 类型 |
| `frontend/src/app/store.ts` | 根 reducer/类型 | Modify：`AppAction` 纳入 `ActiveRunAction` |
| `frontend/src/conversations/state.ts` | 会话切片 | Modify：新增 messageAppended/draftCreated/draftActivated |
| `frontend/src/conversations/useConversationLoader.ts` | 会话编排 | Modify：切换/新建时清空流式态 |
| `frontend/src/runs/useRunStream.ts` | 流式消费编排 | Modify：做实 `start()` |
| `frontend/src/conversations/useSendMessage.ts` | 发送编排 | Create |
| `frontend/src/messages/ThinkingBlock.tsx` | 思考折叠区 | Modify：正文到达自动收起 |
| `frontend/src/messages/StreamingMessage.tsx` | 流式助手气泡 | Create |
| `frontend/src/messages/MessageThread.tsx` | 消息列表 | Modify：接受 children |
| `frontend/src/messages/useStickToBottom.ts` | near-bottom 自动滚动 | Create |
| `frontend/src/ui/Composer.tsx` | 输入框 | Modify：逐行对齐 demo（`onSend`/`onStop`/`state` 三态） |
| `frontend/src/app/AppShell.tsx` | 工作台总装配 | Modify：接线发送/停止/流式/滚动 |

> **严格复刻 `chatapp_demo`**：所有 UI 标记、类名、文案以 `chatapp_demo/components.jsx`（`Message` 助手分支 471–571 行、`Composer` 576–664 行、`ThinkingBlock` 271–373 行）与 `styles.css` 为准。`.caret` / `.status-pill(.stopped/.failed)` / `.stop-btn` / `.body.md` 等类**已存在**于 `frontend/src/styles/chat.css`（前序步骤从 demo 移植），本轮**不新增 CSS**；若发现缺失类，从 `chatapp_demo/styles.css` 对应段补齐，不自创。

所有命令在 `frontend/` 目录下执行。单文件测试用 `pnpm exec vitest run <path>`。

---

### Task 1: Run API 类型、Services 装配与测试基建

**Files:**
- Modify: `frontend/src/api/runs.ts`
- Modify: `frontend/src/app/context.ts`
- Modify: `frontend/src/app/AppProvider.tsx`
- Modify: `frontend/src/test/apiFixtures.ts`
- Modify: `frontend/src/test/appHarness.tsx`

- [ ] **Step 1: 给 runs.ts 导出 RunApi 类型别名**

在 `frontend/src/api/runs.ts` 末尾、`export const runApi = createRunApi();` 之前加入：

```ts
export type RunApi = ReturnType<typeof createRunApi>;
```

- [ ] **Step 2: Services 类型增加 runApi**

修改 `frontend/src/app/context.ts`：在 import 区加入 `import type { RunApi } from "../api/runs";`，并把 `Services` 改为：

```ts
export type Services = {
  authApi: AuthApi;
  conversationApi: ConversationApi;
  runApi: RunApi;
};
```

- [ ] **Step 3: AppProvider 真实分支装配 runApi**

修改 `frontend/src/app/AppProvider.tsx`：在 import 区加入 `import { createRunApi } from "../api/runs";`，并把真实分支的返回对象改为：

```ts
    return {
      authApi: createAuthApi(client),
      conversationApi: createConversationApi(client),
      runApi: createRunApi(client),
    };
```

- [ ] **Step 4: 新增测试 fixtures**

在 `frontend/src/test/apiFixtures.ts` 的 `succeededEvent` 之后加入：

```ts
export const reasoningDeltaEvent: RunEventResponse = {
  seq: 1,
  type: "reasoning_delta",
  payload: { text: "思考中" },
  created_at: "2026-05-24T10:02:00Z",
};

export const failedEvent: RunEventResponse = {
  seq: 3,
  type: "run_failed",
  payload: {},
  created_at: "2026-05-24T10:02:03Z",
};
```

- [ ] **Step 5: appHarness 增加 fakeStream + createFakeRunApi + 第三参数**

修改 `frontend/src/test/appHarness.tsx`。在 import 区补充类型与 fixture：

```ts
import type { RunApi } from "../api/runs";
import type { RunEventResponse, RunStreamEvent } from "../api/types";
import {
  authTokenResponse,
  conversationDetailResponse,
  conversationResponse,
  runStateResponse,
  sendMessageResponse,
} from "./apiFixtures";
```

在 `createFakeConversationApi` 之后加入：

```ts
export async function* fakeStream(
  events: RunEventResponse[],
): AsyncGenerator<RunStreamEvent> {
  for (const data of events) {
    yield { seq: data.seq, type: data.type, data };
  }
}

export function createFakeRunApi(overrides: Partial<RunApi> = {}): RunApi {
  return {
    state: async () => runStateResponse,
    cancel: async () => ({ status: "ok" }),
    streamEvents: () => fakeStream([]),
    ...overrides,
  };
}
```

把 `createFakeServices` 改为接受第三参数：

```ts
export function createFakeServices(
  authApi: Partial<AuthApi> = {},
  conversationApi: Partial<ConversationApi> = {},
  runApi: Partial<RunApi> = {},
): Services {
  return {
    authApi: createFakeAuthApi(authApi),
    conversationApi: createFakeConversationApi(conversationApi),
    runApi: createFakeRunApi(runApi),
  };
}
```

- [ ] **Step 6: 运行类型检查确认装配正确**

Run: `pnpm run typecheck`
Expected: PASS（无 `runApi` 缺失报错；现有测试因 `createFakeServices` 向后兼容不受影响）。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/runs.ts frontend/src/app/context.ts frontend/src/app/AppProvider.tsx frontend/src/test/apiFixtures.ts frontend/src/test/appHarness.tsx
git commit -m "feat(frontend): wire runApi into services and test harness"
```

---

### Task 2: 做实 activeRunReducer

**Files:**
- Modify: `frontend/src/runs/state.ts`
- Modify: `frontend/src/app/store.ts`
- Test: `frontend/src/runs/state.test.ts` (Create)

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/runs/state.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { activeRunReducer, initialActiveRunState, type ActiveRunState } from "./state";

const started: ActiveRunState = {
  runId: 100,
  conversationId: 10,
  latestSeq: 0,
  draftText: "",
  draftReasoning: "",
  status: "started",
  cancelRequested: false,
};

describe("activeRunReducer", () => {
  it("starts a run from null", () => {
    const next = activeRunReducer(null, {
      type: "run/started",
      runId: 100,
      conversationId: 10,
    });
    expect(next).toEqual(started);
  });

  it("accumulates reasoning deltas", () => {
    const a = activeRunReducer(started, { type: "run/reasoningDelta", seq: 1, text: "想" });
    const b = activeRunReducer(a, { type: "run/reasoningDelta", seq: 2, text: "法" });
    expect(b?.draftReasoning).toBe("想法");
    expect(b?.latestSeq).toBe(2);
    expect(b?.status).toBe("streaming");
  });

  it("accumulates text deltas", () => {
    const a = activeRunReducer(started, { type: "run/textDelta", seq: 3, text: "Hel" });
    const b = activeRunReducer(a, { type: "run/textDelta", seq: 4, text: "lo" });
    expect(b?.draftText).toBe("Hello");
    expect(b?.latestSeq).toBe(4);
    expect(b?.status).toBe("streaming");
  });

  it("sets terminal status but keeps drafts", () => {
    const streaming = activeRunReducer(started, { type: "run/textDelta", seq: 1, text: "x" });
    const failed = activeRunReducer(streaming, { type: "run/terminal", status: "failed" });
    expect(failed?.status).toBe("failed");
    expect(failed?.draftText).toBe("x");
  });

  it("marks cancel requested", () => {
    const next = activeRunReducer(started, { type: "run/cancelRequested" });
    expect(next?.cancelRequested).toBe(true);
    expect(next?.status).toBe("cancelling");
  });

  it("clears to null", () => {
    expect(activeRunReducer(started, { type: "run/cleared" })).toBeNull();
  });

  it("resets on app/reset", () => {
    expect(activeRunReducer(started, { type: "app/reset" })).toBe(initialActiveRunState);
  });

  it("ignores actions when state is null", () => {
    expect(activeRunReducer(null, { type: "run/textDelta", seq: 1, text: "x" })).toBeNull();
    expect(activeRunReducer(null, { type: "run/terminal", status: "failed" })).toBeNull();
    expect(activeRunReducer(null, { type: "run/cancelRequested" })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/runs/state.test.ts`
Expected: FAIL（reducer 当前不识别 `run/*` action，类型与断言均不通过）。

- [ ] **Step 3: 做实 reducer**

把 `frontend/src/runs/state.ts` 改为：

```ts
import type { RunStatus } from "../api/types";
import type { AppAction } from "../app/store";

// AbortController is intentionally NOT stored in the reducer (not serializable).
// useRunStream registers its abort via streamAbort; only serializable state lives here.
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

export type ActiveRunAction =
  | { type: "run/started"; runId: number; conversationId: number }
  | { type: "run/reasoningDelta"; seq: number; text: string }
  | { type: "run/textDelta"; seq: number; text: string }
  | { type: "run/terminal"; status: "succeeded" | "failed" | "cancelled" }
  | { type: "run/cancelRequested" }
  | { type: "run/cleared" };

export function activeRunReducer(
  state: ActiveRunState,
  action: AppAction,
): ActiveRunState {
  switch (action.type) {
    case "run/started":
      return {
        runId: action.runId,
        conversationId: action.conversationId,
        latestSeq: 0,
        draftText: "",
        draftReasoning: "",
        status: "started",
        cancelRequested: false,
      };
    case "run/reasoningDelta":
      if (state === null) return state;
      return {
        ...state,
        draftReasoning: state.draftReasoning + action.text,
        latestSeq: action.seq,
        status: "streaming",
      };
    case "run/textDelta":
      if (state === null) return state;
      return {
        ...state,
        draftText: state.draftText + action.text,
        latestSeq: action.seq,
        status: "streaming",
      };
    case "run/terminal":
      if (state === null) return state;
      return { ...state, status: action.status };
    case "run/cancelRequested":
      if (state === null) return state;
      return { ...state, cancelRequested: true, status: "cancelling" };
    case "run/cleared":
      return null;
    case "app/reset":
      return initialActiveRunState;
    default:
      return state;
  }
}
```

- [ ] **Step 4: 把 ActiveRunAction 纳入 AppAction**

修改 `frontend/src/app/store.ts`：把第 12 行的 import 改为同时导入 action 类型：

```ts
import {
  activeRunReducer,
  initialActiveRunState,
  type ActiveRunAction,
  type ActiveRunState,
} from "../runs/state";
```

并把 `AppAction` 联合补上 `ActiveRunAction`：

```ts
export type AppAction =
  | AuthAction
  | ConversationIndexAction
  | ConversationDetailAction
  | UiAction
  | ActiveRunAction
  | AppResetAction;
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run src/runs/state.test.ts`
Expected: PASS（8 个用例全过）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/runs/state.ts frontend/src/runs/state.test.ts frontend/src/app/store.ts
git commit -m "feat(frontend): implement active run reducer"
```

---

### Task 3: 会话切片新增 messageAppended / draftCreated / draftActivated

**Files:**
- Modify: `frontend/src/conversations/state.ts`
- Test: `frontend/src/conversations/state.test.ts` (Modify)

- [ ] **Step 1: 写失败测试**

在 `frontend/src/conversations/state.test.ts` 末尾追加（保持文件已有 import；若缺少则补 `import { sendMessageResponse } from "../test/apiFixtures";` 与被测 reducer/initial 的 import）：

```ts
describe("conversation slices - streaming additions", () => {
  it("appends a message to detail", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation: conversationResponse,
      messages: [],
    });
    const next = conversationDetailReducer(ready, {
      type: "conversations/messageAppended",
      message: sendMessageResponse.message,
    });
    expect(next.messages).toEqual([sendMessageResponse.message]);
  });

  it("sets and clears draftId", () => {
    const created = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/draftCreated",
      id: 42,
    });
    expect(created.draftId).toBe(42);
    const activated = conversationIndexReducer(created, {
      type: "conversations/draftActivated",
    });
    expect(activated.draftId).toBeNull();
  });
});
```

> 注：该文件已有 `import { conversationDetailResponse, conversationResponse } from "../test/apiFixtures";`，把它改为 `import { conversationDetailResponse, conversationResponse, sendMessageResponse } from "../test/apiFixtures";` 以引入新 fixture。`conversationDetailReducer` / `conversationIndexReducer` / `initialConversationDetailState` / `initialConversationIndexState` 已在文件顶部导入。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/conversations/state.test.ts`
Expected: FAIL（reducer 不识别新 action）。

- [ ] **Step 3: 实现 detail 的 messageAppended**

修改 `frontend/src/conversations/state.ts`。把 `ConversationDetailAction` 联合补一条：

```ts
export type ConversationDetailAction =
  | { type: "conversations/detailLoading" }
  | {
      type: "conversations/detailLoaded";
      conversation: ConversationResponse;
      messages: MessageResponse[];
    }
  | { type: "conversations/messageAppended"; message: MessageResponse }
  | { type: "conversations/detailForbidden" }
  | { type: "conversations/detailReset" };
```

在 `conversationDetailReducer` 的 `switch` 中、`detailLoaded` 之后加入：

```ts
    case "conversations/messageAppended":
      return { ...state, messages: [...state.messages, action.message] };
```

- [ ] **Step 4: 实现 index 的 draftCreated / draftActivated**

把 `ConversationIndexAction` 联合补两条：

```ts
export type ConversationIndexAction =
  | { type: "conversations/listLoading" }
  | { type: "conversations/listLoaded"; items: ConversationResponse[] }
  | { type: "conversations/listError" }
  | { type: "conversations/selected"; id: number | null }
  | { type: "conversations/renamed"; conversation: ConversationResponse }
  | { type: "conversations/removed"; id: number }
  | { type: "conversations/draftCreated"; id: number }
  | { type: "conversations/draftActivated" };
```

在 `conversationIndexReducer` 的 `switch` 中、`removed` 之后加入：

```ts
    case "conversations/draftCreated":
      return { ...state, draftId: action.id };
    case "conversations/draftActivated":
      return { ...state, draftId: null };
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run src/conversations/state.test.ts`
Expected: PASS（新增 2 用例 + 既有用例全过）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/conversations/state.ts frontend/src/conversations/state.test.ts
git commit -m "feat(frontend): add messageAppended and draft lifecycle actions"
```

---

### Task 4: 切换/新建会话时清空流式态

**Files:**
- Modify: `frontend/src/conversations/useConversationLoader.ts`
- Test: `frontend/src/conversations/useConversationLoader.test.tsx` (Modify)

- [ ] **Step 1: 写失败测试**

在 `frontend/src/conversations/useConversationLoader.test.tsx` 顶部 import 区补充：

```tsx
import { useAppActions, useAppState } from "../app/context";
import { useConversationLoader } from "./useConversationLoader";
```

（`useConversationLoader` 通常已导入，去重即可。）在 `describe("useConversationLoader", ...)` 内追加一个探针与两个用例：

```tsx
  function useClearProbe() {
    const loader = useConversationLoader();
    const { activeRun } = useAppState();
    const { dispatch } = useAppActions();
    return { loader, activeRun, dispatch };
  }

  it("clears the active run when selecting another conversation", async () => {
    const services = createFakeServices(
      {},
      { detail: async () => conversationDetailResponse },
    );
    const { result } = renderHook(() => useClearProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: 1, conversationId: 10 });
    });
    expect(result.current.activeRun).not.toBeNull();

    await act(async () => {
      await result.current.loader.selectConversation(conversationResponse.id);
    });
    expect(result.current.activeRun).toBeNull();
  });

  it("clears the active run on newConversation", async () => {
    const services = createFakeServices();
    const { result } = renderHook(() => useClearProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: 1, conversationId: 10 });
    });
    expect(result.current.activeRun).not.toBeNull();

    act(() => {
      result.current.loader.newConversation();
    });
    expect(result.current.activeRun).toBeNull();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/conversations/useConversationLoader.test.tsx`
Expected: FAIL（`selectConversation` / `newConversation` 当前不派发 `run/cleared`，切换后 activeRun 仍非空）。

- [ ] **Step 3: 在 select/new 中派发 run/cleared**

修改 `frontend/src/conversations/useConversationLoader.ts`。在 `newConversation` 内、`selectionStore.clear()` 之前加入清空：

```ts
  const newConversation = useCallback(() => {
    dispatch({ type: "run/cleared" });
    dispatch({ type: "conversations/selected", id: null });
    dispatch({ type: "conversations/detailReset" });
    dispatch({ type: "ui/setMobileSidebar", open: false });
    selectionStore.clear();
  }, [dispatch]);
```

在 `selectConversation` 内、最开头加入：

```ts
    async (id: number) => {
      dispatch({ type: "run/cleared" });
      dispatch({ type: "conversations/selected", id });
      dispatch({ type: "conversations/detailLoading" });
      dispatch({ type: "ui/setMobileSidebar", open: false });
      // ...rest unchanged
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/conversations/useConversationLoader.test.tsx`
Expected: PASS（新增 2 用例 + 既有 6 用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/conversations/useConversationLoader.ts frontend/src/conversations/useConversationLoader.test.tsx
git commit -m "feat(frontend): clear active run when switching conversation"
```

---

### Task 5: 做实 useRunStream

**Files:**
- Modify: `frontend/src/runs/useRunStream.ts`
- Test: `frontend/src/runs/useRunStream.test.tsx` (Create)

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/runs/useRunStream.test.tsx`。注意：`start` 自身**不**派发 `run/started`（那是 `useSendMessage` 的职责），所以成功用例需先 `dispatch({type:"conversations/selected", id})` 让 `selectedIdRef` 命中，detail 才会被应用。

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAppActions, useAppState } from "../app/context";
import {
  conversationDetailResponse,
  conversationResponse,
  reasoningDeltaEvent,
  succeededEvent,
  textDeltaEvent,
} from "../test/apiFixtures";
import { createFakeServices, fakeStream, makeWrapper } from "../test/appHarness";
import { useRunStream } from "./useRunStream";

function useStreamProbe() {
  const { start, cancel } = useRunStream();
  const { activeRun, conversationDetail } = useAppState();
  const { dispatch } = useAppActions();
  return { start, cancel, activeRun, conversationDetail, dispatch };
}

describe("useRunStream", () => {
  it("replaces with server detail on success when still on that conversation", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices(
      {},
      { detail, list },
      {
        streamEvents: () =>
          fakeStream([
            { ...reasoningDeltaEvent, seq: 1 },
            { ...textDeltaEvent, seq: 2 },
            { ...succeededEvent, seq: 3 },
          ]),
      },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: conversationResponse.id });
    });
    await act(async () => {
      await result.current.start(100, conversationResponse.id, 0);
    });

    expect(detail).toHaveBeenCalledWith(conversationResponse.id);
    expect(list).toHaveBeenCalled();
    expect(result.current.activeRun).toBeNull();
    expect(result.current.conversationDetail.messages).toEqual(
      conversationDetailResponse.messages,
    );
  });

  it("does not apply detail when the user navigated away", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const list = vi.fn(async () => [conversationResponse]);
    const services = createFakeServices(
      {},
      { detail, list },
      { streamEvents: () => fakeStream([{ ...succeededEvent, seq: 1 }]) },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    // selectedId stays null while the run targets conversation 10.
    await act(async () => {
      await result.current.start(100, conversationResponse.id, 0);
    });

    expect(detail).toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
    // detailLoaded skipped: detail not applied to the (different) current view.
    expect(result.current.conversationDetail.messages).toEqual([]);
  });

  it("does not refetch detail on failure", async () => {
    const detail = vi.fn(async () => conversationDetailResponse);
    const services = createFakeServices(
      {},
      { detail },
      {
        streamEvents: () =>
          fakeStream([{ seq: 1, type: "run_failed", payload: {}, created_at: "x" }]),
      },
    );
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.start(100, conversationResponse.id, 0);
    });

    expect(detail).not.toHaveBeenCalled();
  });

  it("requests cancellation and flips to stopping", async () => {
    const cancel = vi.fn(async () => ({ status: "ok" }));
    const services = createFakeServices({}, {}, { cancel });
    const { result } = renderHook(() => useStreamProbe(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      result.current.dispatch({ type: "run/started", runId: 100, conversationId: 10 });
    });
    await act(async () => {
      await result.current.cancel(100);
    });

    expect(cancel).toHaveBeenCalledWith(100);
    expect(result.current.activeRun?.cancelRequested).toBe(true);
    expect(result.current.activeRun?.status).toBe("cancelling");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/runs/useRunStream.test.tsx`
Expected: FAIL（`useRunStream` 当前抛 `Error("useRunStream is implemented in a later refactor step")`）。

- [ ] **Step 3: 做实 useRunStream**

把 `frontend/src/runs/useRunStream.ts` 改为：

```ts
import { useCallback, useRef } from "react";

import { isAbortError } from "../api/errors";
import { useAppActions, useAppState } from "../app/context";

export function useRunStream() {
  const { conversationIndex } = useAppState();
  const { dispatch, services, streamAbort } = useAppActions();
  const { conversationApi, runApi } = services;

  // Latest selected conversation, read inside the async terminal handler so a
  // run that finishes after the user navigated away does not overwrite detail.
  const selectedIdRef = useRef(conversationIndex.selectedId);
  selectedIdRef.current = conversationIndex.selectedId;

  const start = useCallback(
    async (runId: number, conversationId: number, afterSeq: number): Promise<void> => {
      const controller = new AbortController();
      streamAbort.register(() => controller.abort());

      try {
        for await (const event of runApi.streamEvents(runId, afterSeq, {
          signal: controller.signal,
        })) {
          const raw = event.data.payload.text;
          const text = typeof raw === "string" ? raw : "";

          if (event.type === "reasoning_delta") {
            dispatch({ type: "run/reasoningDelta", seq: event.seq, text });
          } else if (event.type === "text_delta") {
            dispatch({ type: "run/textDelta", seq: event.seq, text });
          } else if (
            event.type === "run_succeeded" ||
            event.type === "run_failed" ||
            event.type === "run_cancelled"
          ) {
            const status =
              event.type === "run_succeeded"
                ? "succeeded"
                : event.type === "run_failed"
                  ? "failed"
                  : "cancelled";
            dispatch({ type: "run/terminal", status });

            if (status === "succeeded") {
              const [detail, list] = await Promise.all([
                conversationApi.detail(conversationId),
                conversationApi.list(),
              ]);
              dispatch({ type: "conversations/listLoaded", items: list });
              dispatch({ type: "conversations/draftActivated" });
              if (selectedIdRef.current === conversationId) {
                const { messages, ...conversation } = detail;
                dispatch({ type: "conversations/detailLoaded", conversation, messages });
              }
              dispatch({ type: "run/cleared" });
            }
          }
        }
      } catch (error) {
        if (isAbortError(error)) return;
        dispatch({ type: "run/terminal", status: "failed" });
      }
    },
    [dispatch, conversationApi, runApi, streamAbort],
  );

  // Optimistically flip to "停止中" and ask the server to cancel. We do NOT abort
  // the local stream — the server's run_cancelled event arrives over SSE and
  // drives the terminal transition (so "已停止" only shows after the real terminal).
  const cancel = useCallback(
    async (runId: number): Promise<void> => {
      dispatch({ type: "run/cancelRequested" });
      try {
        await runApi.cancel(runId);
      } catch {
        // Swallow: the SSE terminal still arrives, or the user can retry.
      }
    },
    [dispatch, runApi],
  );

  return { start, cancel };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/runs/useRunStream.test.tsx`
Expected: PASS（4 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/runs/useRunStream.ts frontend/src/runs/useRunStream.test.tsx
git commit -m "feat(frontend): implement useRunStream SSE consumer"
```

---

### Task 6: 新增 useSendMessage

**Files:**
- Create: `frontend/src/conversations/useSendMessage.ts`
- Test: `frontend/src/conversations/useSendMessage.test.tsx` (Create)

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/conversations/useSendMessage.test.tsx`。已选中路径通过探针暴露的 `dispatch` 预置 `selectedId`（选择态由 reducer 持有）。

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppActions, useAppState } from "../app/context";
import type { ConversationResponse } from "../api/types";
import { conversationResponse, sendMessageResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { selectionStore } from "./selectionStore";
import { useSendMessage } from "./useSendMessage";

const draft: ConversationResponse = {
  id: 77,
  title: null,
  activated_at: null,
  created_at: "t",
  updated_at: "t",
};

type Start = (runId: number, conversationId: number, afterSeq: number) => void;

function useSendProbe(start: Start) {
  const send = useSendMessage(start);
  const { conversationIndex, conversationDetail, activeRun } = useAppState();
  const { dispatch } = useAppActions();
  return { send, conversationIndex, conversationDetail, activeRun, dispatch };
}

describe("useSendMessage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("creates a draft conversation when none is selected", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("你好");
    });

    expect(create).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(77, "你好");
    expect(result.current.conversationIndex.selectedId).toBe(77);
    expect(result.current.conversationIndex.draftId).toBe(77);
    expect(selectionStore.read()).toBe(77);
    expect(start).toHaveBeenCalledWith(sendMessageResponse.run.id, 77, 0);
    await waitFor(() =>
      expect(result.current.activeRun?.runId).toBe(sendMessageResponse.run.id),
    );
  });

  it("sends to the already-selected conversation without creating a draft", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      result.current.dispatch({ type: "conversations/selected", id: 55 });
    });
    await act(async () => {
      await result.current.send("世界");
    });

    expect(create).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(55, "世界");
    expect(result.current.conversationDetail.messages.at(-1)).toEqual(
      sendMessageResponse.message,
    );
  });

  it("ignores empty content", async () => {
    const start = vi.fn();
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("   ");
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps state usable when sendMessage rejects", async () => {
    const start = vi.fn();
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(start), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("会失败");
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(result.current.activeRun).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/conversations/useSendMessage.test.tsx`
Expected: FAIL（`useSendMessage` 不存在）。

- [ ] **Step 3: 实现 useSendMessage**

创建 `frontend/src/conversations/useSendMessage.ts`：

```ts
import { useCallback } from "react";

import { useAppActions, useAppState } from "../app/context";
import { selectionStore } from "./selectionStore";

// `start` is injected by AppShell (which owns the single useRunStream instance),
// so this hook stays free of streaming wiring and is trivially testable with a spy.
export function useSendMessage(
  start: (runId: number, conversationId: number, afterSeq: number) => void,
) {
  const { conversationIndex } = useAppState();
  const { dispatch, services } = useAppActions();
  const { conversationApi } = services;

  return useCallback(
    async (content: string): Promise<void> => {
      const trimmed = content.trim();
      if (trimmed === "") return;

      try {
        let targetId = conversationIndex.selectedId;
        if (targetId == null) {
          const convo = await conversationApi.create();
          targetId = convo.id;
          dispatch({ type: "conversations/detailLoaded", conversation: convo, messages: [] });
          dispatch({ type: "conversations/selected", id: convo.id });
          dispatch({ type: "conversations/draftCreated", id: convo.id });
          selectionStore.save(convo.id);
        }

        const { message, run } = await conversationApi.sendMessage(targetId, trimmed);
        dispatch({ type: "conversations/messageAppended", message });
        dispatch({ type: "run/started", runId: run.id, conversationId: targetId });
        void start(run.id, targetId, 0);
      } catch (error) {
        // Send failed before streaming started. Keep input so the user can retry;
        // a user-facing Toast lands in a later step.
        console.error("send message failed", error);
      }
    },
    [conversationIndex.selectedId, dispatch, conversationApi, start],
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/conversations/useSendMessage.test.tsx`
Expected: PASS（4 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/conversations/useSendMessage.ts frontend/src/conversations/useSendMessage.test.tsx
git commit -m "feat(frontend): add useSendMessage orchestration"
```

---

### Task 7: ThinkingBlock 正文到达自动收起

**Files:**
- Modify: `frontend/src/messages/ThinkingBlock.tsx`
- Test: `frontend/src/messages/ThinkingBlock.test.tsx` (Modify)

- [ ] **Step 1: 写失败测试**

在 `frontend/src/messages/ThinkingBlock.test.tsx` 追加用例（保留已有用例）：

```tsx
  it("auto-collapses when streaming turns false", () => {
    const { container, rerender } = render(
      <ThinkingBlock content="想法" streaming={true} />,
    );
    expect(container.querySelector(".thinking")?.className).not.toContain("collapsed");

    rerender(<ThinkingBlock content="想法" streaming={false} />);
    expect(container.querySelector(".thinking")?.className).toContain("collapsed");
  });
```

（文件已 `import { render, screen } from "@testing-library/react";`，直接使用 `render` 的返回值 `container` / `rerender`。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/messages/ThinkingBlock.test.tsx`
Expected: FAIL（当前 `open` 仅初始化一次，rerender 不会收起）。

- [ ] **Step 3: 加入随 streaming 翻转的 effect**

修改 `frontend/src/messages/ThinkingBlock.tsx`：把 `import { useState } from "react";` 改为 `import { useEffect, useState } from "react";`，并在 `const [open, setOpen] = useState(streaming);` 之后加入：

```ts
  // Expand while reasoning streams; auto-collapse once body text arrives
  // (caller flips `streaming` to false). Manual toggling within a phase persists.
  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/messages/ThinkingBlock.test.tsx`
Expected: PASS（既有用例 + 新用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/ThinkingBlock.tsx frontend/src/messages/ThinkingBlock.test.tsx
git commit -m "feat(frontend): auto-collapse thinking block when body text starts"
```

---

### Task 8: StreamingMessage 组件（严格复刻 demo 助手气泡）

**严格复刻**：标记/类名/文案逐项对齐 `chatapp_demo/components.jsx` 的 `Message` 助手分支（第 471–571 行）：流式光标 `.caret`、`.status-pill.stopped`「已停止」（带小方点 span）、`.status-pill.failed`（`<Icons.Close>` + `生成失败 · 请稍后重试`）。**不新增 CSS**——这些类已在 `frontend/src/styles/chat.css`（569/583/596/597 行）。

**Files:**
- Create: `frontend/src/messages/StreamingMessage.tsx`
- Test: `frontend/src/messages/StreamingMessage.test.tsx` (Create)

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/StreamingMessage.test.tsx`。断言锚定 demo 类名，作为保真检查：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActiveRunState } from "../runs/state";
import { StreamingMessage } from "./StreamingMessage";

function run(overrides: Partial<NonNullable<ActiveRunState>>): NonNullable<ActiveRunState> {
  return {
    runId: 1,
    conversationId: 10,
    latestSeq: 1,
    draftText: "",
    draftReasoning: "",
    status: "streaming",
    cancelRequested: false,
    ...overrides,
  };
}

describe("StreamingMessage", () => {
  it("renders streamed body text in a .body.md block", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "Hello world", status: "streaming" })} />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(container.querySelector(".body.md")).toBeTruthy();
  });

  it("shows the blinking caret while streaming", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "Hel", status: "streaming" })} />,
    );
    expect(container.querySelector(".caret")).toBeTruthy();
  });

  it("renders the reasoning block", () => {
    render(<StreamingMessage run={run({ draftReasoning: "在想", status: "streaming" })} />);
    expect(screen.getByText("在想")).toBeInTheDocument();
  });

  it("shows the failed status-pill (demo copy)", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "部分", status: "failed" })} />,
    );
    expect(container.querySelector(".status-pill.failed")).toBeTruthy();
    expect(screen.getByText("生成失败 · 请稍后重试")).toBeInTheDocument();
    expect(container.querySelector(".caret")).toBeNull();
  });

  it("shows the stopped status-pill (demo copy)", () => {
    const { container } = render(
      <StreamingMessage run={run({ draftText: "部分", status: "cancelled" })} />,
    );
    expect(container.querySelector(".status-pill.stopped")).toBeTruthy();
    expect(screen.getByText("已停止")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/messages/StreamingMessage.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现组件**

创建 `frontend/src/messages/StreamingMessage.tsx`。结构与 demo 助手分支逐项对齐（`.caret` / `.status-pill` / 内联方点样式均原样照搬 demo 第 529–541 行）：

```tsx
import type { ActiveRunState } from "../runs/state";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type StreamingMessageProps = { run: NonNullable<ActiveRunState> };

export function StreamingMessage({ run }: StreamingMessageProps) {
  const isStreaming =
    run.status === "queued" ||
    run.status === "started" ||
    run.status === "streaming" ||
    run.status === "cancelling";
  const thinking = isStreaming && run.draftText === "";

  return (
    <div className="msg assistant">
      <div style={{ flex: 1, minWidth: 0 }}>
        {run.draftReasoning && (
          <ThinkingBlock content={run.draftReasoning} streaming={thinking} />
        )}
        <Markdown content={run.draftText} />
        {isStreaming && <span className="caret" />}
        {run.status === "cancelled" && (
          <div className="status-pill stopped">
            <span
              style={{ width: 8, height: 8, background: "var(--fg-subtle)", borderRadius: 2 }}
            />
            已停止
          </div>
        )}
        {run.status === "failed" && (
          <div className="status-pill failed">
            <Icons.Close size={12} />
            生成失败 · 请稍后重试
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/messages/StreamingMessage.test.tsx`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/StreamingMessage.tsx frontend/src/messages/StreamingMessage.test.tsx
git commit -m "feat(frontend): add streaming assistant message replicating the demo"
```

---

### Task 9: Composer 逐行对齐 demo（send/stop 三态）

**严格复刻**：props 形状与渲染对齐 `chatapp_demo/components.jsx` 的 `Composer`（第 576–664 行）：`{ value, onChange, onSend, onStop, state }`，`state` 为 `"idle" | "streaming" | "stopping"`；idle 渲染 `.send-btn`，否则渲染 `.stop-btn`（stopping 时禁用）。

**Files:**
- Modify: `frontend/src/ui/Composer.tsx`
- Test: `frontend/src/ui/Composer.test.tsx` (Modify)

- [ ] **Step 1: 改写测试**

把 `frontend/src/ui/Composer.test.tsx` 整体替换为：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

const noop = () => {};

describe("Composer", () => {
  it("disables send when empty (idle)", () => {
    render(<Composer value="" onChange={noop} onSend={noop} onStop={noop} state="idle" />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("enables send with non-empty input (idle)", () => {
    render(<Composer value="hi" onChange={noop} onSend={noop} onStop={noop} state="idle" />);
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("calls onSend on Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={onSend} onStop={noop} state="idle" />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalled();
  });

  it("does not send on Shift+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={onSend} onStop={noop} state="idle" />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clicking send calls onSend", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={onSend} onStop={noop} state="idle" />);
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("shows the stop button while streaming and calls onStop", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={noop} onSend={noop} onStop={onStop} state="streaming" />);
    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toBeEnabled();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    await user.click(stop);
    expect(onStop).toHaveBeenCalled();
  });

  it("disables the stop button while stopping", () => {
    render(<Composer value="hi" onChange={noop} onSend={noop} onStop={noop} state="stopping" />);
    expect(screen.getByRole("button", { name: "停止中" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/ui/Composer.test.tsx`
Expected: FAIL（Composer 还是旧 props，无 `onSend`/`onStop`/`state`，无 stop-btn）。

- [ ] **Step 3: 实现 Composer（对齐 demo）**

把 `frontend/src/ui/Composer.tsx` 改为（逐行对齐 demo Composer，去掉 demo 的 float/maxHeight 入参——本应用不用浮层布局）：

```tsx
import { useEffect, useRef } from "react";

import { Icons } from "./icons";

type ComposerState = "idle" | "streaming" | "stopping";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  state: ComposerState;
};

const MAX_HEIGHT = 240;

export function Composer({ value, onChange, onSend, onStop, state }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const send = () => {
    if (!value.trim() || state !== "idle") return;
    onSend();
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="有问题，尽管问"
          rows={1}
          style={{ maxHeight: `${MAX_HEIGHT}px` }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          <div className="composer-actions-left">
            <button className="composer-tool" type="button" aria-label="添加附件">
              <Icons.Plus size={16} />
            </button>
          </div>
          <div className="composer-actions-right">
            <button className="composer-mode" type="button" aria-label="模型模式">
              <span>Instant</span>
              <Icons.Chevron size={14} />
            </button>
            <button className="composer-tool" type="button" aria-label="语音输入">
              <Icons.Mic size={16} />
            </button>
            {state === "idle" ? (
              <button
                className="send-btn"
                type="button"
                aria-label="发送"
                disabled={!value.trim()}
                onClick={send}
              >
                <Icons.ArrowUp size={15} />
              </button>
            ) : (
              <button
                className="stop-btn"
                type="button"
                aria-label={state === "stopping" ? "停止中" : "停止生成"}
                disabled={state === "stopping"}
                onClick={onStop}
              >
                <Icons.Stop size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/ui/Composer.test.tsx`
Expected: PASS（7 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/Composer.tsx frontend/src/ui/Composer.test.tsx
git commit -m "feat(frontend): replicate demo composer with send/stop states"
```

---

### Task 10: near-bottom 自动滚动

**Files:**
- Create: `frontend/src/messages/useStickToBottom.ts`
- Test: `frontend/src/messages/useStickToBottom.test.ts` (Create)

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/useStickToBottom.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { isNearBottom } from "./useStickToBottom";

describe("isNearBottom", () => {
  it("is true when within threshold of the bottom", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 930, clientHeight: 100 })).toBe(true);
  });

  it("is false when scrolled up to read history", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 100 })).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 100 }, 250)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/messages/useStickToBottom.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 hook + 纯函数**

创建 `frontend/src/messages/useStickToBottom.ts`：

```ts
import { useEffect, useRef } from "react";

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

export function isNearBottom(el: Metrics, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

// Sticks the scroll container to the bottom on dependency change, but only when
// the user is already near the bottom — leaves them alone while reading history.
export function useStickToBottom<T extends HTMLElement>(deps: ReadonlyArray<unknown>) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isNearBottom(el)) {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/messages/useStickToBottom.test.ts`
Expected: PASS（3 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/useStickToBottom.ts frontend/src/messages/useStickToBottom.test.ts
git commit -m "feat(frontend): add near-bottom auto-scroll hook"
```

---

### Task 11: AppShell 接线 + MessageThread children + 集成测试

**Files:**
- Modify: `frontend/src/messages/MessageThread.tsx`
- Modify: `frontend/src/app/AppShell.tsx`
- Test: `frontend/src/app/AppShell.test.tsx` (Modify)

- [ ] **Step 1: MessageThread 接受 children**

把 `frontend/src/messages/MessageThread.tsx` 改为：

```tsx
import type { ReactNode } from "react";

import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

type MessageThreadProps = { messages: MessageResponse[]; children?: ReactNode };

export function MessageThread({ messages, children }: MessageThreadProps) {
  return (
    <div className="thread-inner">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {children}
    </div>
  );
}
```

- [ ] **Step 2: 写集成测试（失败）**

`AppShell.test.tsx` 现有用例直接 `renderWithApp(<AppShell />, services)`，不需要认证预置（AppShell 在隔离测试中不经过认证门）。把顶部 import 改为同时引入 `waitFor` 与所需 fixture/harness：

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
```

并补充（与既有 import 去重）：

```tsx
import type { ConversationDetailResponse, ConversationResponse, MessageResponse, RunResponse, SendMessageResponse } from "../api/types";
import { reasoningDeltaEvent, succeededEvent, textDeltaEvent } from "../test/apiFixtures";
import { createFakeServices, fakeStream, renderWithApp } from "../test/appHarness";
```

在 `describe("AppShell", ...)` 内追加用例（用带类型注解的 const 避免字面量类型被收窄为 `string`）：

```tsx
  it("sends a message and replaces the stream with the server reply", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: 77, title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: 1, conversation_id: 77, run_id: 100, role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const assistantMessage: MessageResponse = {
      id: 2, conversation_id: 77, run_id: 100, role: "assistant",
      content: "你好呀", reasoning: null, position: 2, created_at: "t",
    };
    const run: RunResponse = {
      id: 100, conversation_id: 77, user_message_id: 1, status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };
    const serverDetail: ConversationDetailResponse = {
      ...draft, activated_at: "t", title: "新对话",
      messages: [userMessage, assistantMessage],
    };

    const services = createFakeServices(
      {},
      {
        list: async () => [],
        create: async () => draft,
        detail: async () => serverDetail,
        sendMessage: async () => sent,
      },
      {
        streamEvents: () =>
          fakeStream([
            { ...reasoningDeltaEvent, seq: 1 },
            { ...textDeltaEvent, seq: 2, payload: { text: "你好" } },
            { ...succeededEvent, seq: 3 },
          ]),
      },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // Server-materialized assistant reply replaces the streamed draft.
    await waitFor(() => expect(screen.getByText("你好呀")).toBeInTheDocument());
    expect(screen.getByText("你好")).toBeInTheDocument();
    // Back to idle: send button returns.
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("swaps the send button for the demo stop button while streaming", async () => {
    const user = userEvent.setup();

    const draft: ConversationResponse = {
      id: 77, title: null, activated_at: null, created_at: "t", updated_at: "t",
    };
    const userMessage: MessageResponse = {
      id: 1, conversation_id: 77, run_id: 100, role: "user",
      content: "你好", reasoning: null, position: 1, created_at: "t",
    };
    const run: RunResponse = {
      id: 100, conversation_id: 77, user_message_id: 1, status: "streaming",
      provider_name: "deepseek", provider_model: "deepseek-chat", created_at: "t",
    };
    const sent: SendMessageResponse = { message: userMessage, run };

    const services = createFakeServices(
      {},
      { list: async () => [], create: async () => draft, sendMessage: async () => sent },
      {
        // No terminal event: the run stays "streaming", so the stop button is stable.
        streamEvents: () =>
          fakeStream([{ ...textDeltaEvent, seq: 1, payload: { text: "你好" } }]),
      },
    );

    renderWithApp(<AppShell />, services);

    const textarea = await screen.findByPlaceholderText("有问题，尽管问");
    await user.type(textarea, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm exec vitest run src/app/AppShell.test.tsx`
Expected: FAIL（AppShell 尚未接 `onSend`/`onStop`/StreamingMessage，发送无效果、无 stop-btn）。

- [ ] **Step 4: AppShell 接线**

修改 `frontend/src/app/AppShell.tsx`：

1）import 区补充：

```tsx
import { StreamingMessage } from "../messages/StreamingMessage";
import { useStickToBottom } from "../messages/useStickToBottom";
import { useSendMessage } from "../conversations/useSendMessage";
import { useRunStream } from "../runs/useRunStream";
```

2）把 `const { ui } = useAppState();` 改为：

```tsx
  const { ui, activeRun } = useAppState();
```

3）在 `const [composerValue, setComposerValue] = useState("");` 之后加入发送 / 停止 / 滚动接线（`useRunStream` 只在此实例化一次，`start` 注入 `useSendMessage`，`cancel` 用于停止）：

```tsx
  const { start, cancel } = useRunStream();
  const send = useSendMessage(start);
  const threadRef = useStickToBottom<HTMLDivElement>([
    detail.messages.length,
    activeRun?.draftText,
    activeRun?.draftReasoning,
    activeRun?.status,
  ]);

  const onSend = () => {
    const text = composerValue;
    setComposerValue("");
    void send(text);
  };

  const onStop = () => {
    if (activeRun) void cancel(activeRun.runId);
  };

  // demo Composer state: idle / streaming / stopping
  const composerState: "idle" | "streaming" | "stopping" =
    activeRun != null && activeRun.conversationId === selectedId
      ? activeRun.cancelRequested || activeRun.status === "cancelling"
        ? "stopping"
        : activeRun.status === "queued" ||
            activeRun.status === "started" ||
            activeRun.status === "streaming"
          ? "streaming"
          : "idle"
      : "idle";
```

4）把 `const showWelcome = selectedId == null || messages.length === 0;` 改为：

```tsx
  const showWelcome = (selectedId == null || messages.length === 0) && activeRun == null;
```

5）把 thread 区与 composer 区替换为：

```tsx
        <div className="thread-region" ref={threadRef}>
          {!showWelcome && (
            <MessageThread messages={messages}>
              {activeRun && activeRun.conversationId === selectedId && (
                <StreamingMessage run={activeRun} />
              )}
            </MessageThread>
          )}
        </div>

        <div className="composer-area">
          <div className={`welcome-section${showWelcome ? "" : " hidden"}`}>
            <h1 className="welcome-heading">我们先从哪里开始呢？</h1>
          </div>
          <Composer
            value={composerValue}
            onChange={setComposerValue}
            onSend={onSend}
            onStop={onStop}
            state={composerState}
          />
        </div>
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run src/app/AppShell.test.tsx`
Expected: PASS（既有用例 + 新集成用例全过）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/messages/MessageThread.tsx frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx
git commit -m "feat(frontend): wire send and SSE streaming into the chat shell"
```

---

### Task 12: 全量校验

**Files:** 无（仅验证）

- [ ] **Step 1: 全量测试**

Run: `pnpm exec vitest run`
Expected: PASS（全部测试通过，数量从 115 增长）。

- [ ] **Step 2: 类型检查**

Run: `pnpm run typecheck`
Expected: PASS。

- [ ] **Step 3: Lint**

Run: `pnpm run lint`
Expected: PASS（注意 `useStickToBottom` 的 `react-hooks/exhaustive-deps` 已就地 disable；如 lint 报 `console` 相关规则，按项目既有约定处理，必要时在 `useSendMessage` 的 catch 内保留 `console.error`——项目未禁用 `no-console`，参照同类用法）。

- [ ] **Step 4: 构建**

Run: `pnpm run build`
Expected: PASS（产物输出到 `frontend/dist/`）。

- [ ] **Step 5: 复刻保真核对（严格复刻 chatapp_demo）**

对照 `chatapp_demo/components.jsx` 与 `styles.css` 逐项核对（自动化锚点已在 Task 8/9 测试中以类名断言）：

- [ ] 流式助手气泡：`.msg.assistant` → flex 容器 → 思考区 / `.body.md` / `.caret`，结构同 demo `Message` 助手分支（471–571）。
- [ ] 状态 pill 文案一字不差：`.status-pill.failed` =「生成失败 · 请稍后重试」、`.status-pill.stopped` =「已停止」（含小方点）。
- [ ] Composer 三态：idle → `.send-btn`（`Icons.ArrowUp`）；streaming → `.stop-btn`（`Icons.Stop`，`aria-label=停止生成`）；stopping → `.stop-btn` disabled（`aria-label=停止中`）。
- [ ] 思考区文案：`思考中…` / `已思考`；正文到达自动收起。
- [ ] 确认 `frontend/src/styles/chat.css` 未新增任何类；用到的 `.caret` / `.status-pill(.stopped/.failed)` / `.stop-btn` / `.body.md` 全部来自既有移植。

- [ ] **Step 6: 视觉 smoke（并排比对，必做）**

浏览器打开 `chatapp_demo/index.html`（直接双击或本地静态服务）作为基准；另起后端 `uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`（`CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`）+ 前端 `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1 pnpm dev`，登录后发一条消息。两窗并排逐项比对：思考过程实时显示与收起、流式光标、停止按钮（点击转「停止中」、终态显示「已停止」）、失败 pill、终态被服务端消息替换、侧栏出现该会话。外观或交互与 demo 有差异即视为未通过，回到对应组件修正。

---

## 完成标准

- 登录后可在空白态（自动建草稿）或已选中会话发送消息。
- 思考过程与正文实时流式渲染；正文到达时思考区自动收起。
- run 成功后服务端物化的助手消息替换流式气泡，侧栏出现该会话。
- run 失败/流错误时保留 partial、显示 `.status-pill.failed`「生成失败 · 请稍后重试」、恢复输入。
- 流式中 Composer 显示停止按钮；点击经 `runApi.cancel` 取消，终态显示 `.status-pill.stopped`「已停止」。
- near-bottom 时自动贴底。
- 切换/新建会话清空流式态；流式中途切走，run 终态不污染当前会话详情。
- **UI 严格复刻 `chatapp_demo`**：类名 / 标记 / 文案逐项一致，组件测试以 demo 类名为锚点断言，并经并排视觉 smoke 通过。
- `pnpm exec vitest run` / `typecheck` / `lint` / `build` 全绿。
