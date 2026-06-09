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
| `frontend/src/ui/Composer.tsx` | 输入框 | Modify：`onSubmit` + `disabled` |
| `frontend/src/app/AppShell.tsx` | 工作台总装配 | Modify：接线发送/流式/滚动 |
| `frontend/src/styles/chat.css` | 样式 | Modify：新增 `.run-status` |

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

  it("clears to null", () => {
    expect(activeRunReducer(started, { type: "run/cleared" })).toBeNull();
  });

  it("resets on app/reset", () => {
    expect(activeRunReducer(started, { type: "app/reset" })).toBe(initialActiveRunState);
  });

  it("ignores deltas when state is null", () => {
    expect(activeRunReducer(null, { type: "run/textDelta", seq: 1, text: "x" })).toBeNull();
    expect(activeRunReducer(null, { type: "run/terminal", status: "failed" })).toBeNull();
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
Expected: PASS（7 个用例全过）。

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
  const { start } = useRunStream();
  const { activeRun, conversationDetail } = useAppState();
  const { dispatch } = useAppActions();
  return { start, activeRun, conversationDetail, dispatch };
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

  return { start };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/runs/useRunStream.test.tsx`
Expected: PASS（3 个用例全过）。

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

function useSendProbe() {
  const send = useSendMessage();
  const { conversationIndex, conversationDetail, activeRun } = useAppState();
  const { dispatch } = useAppActions();
  return { send, conversationIndex, conversationDetail, activeRun, dispatch };
}

describe("useSendMessage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("creates a draft conversation when none is selected", async () => {
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("你好");
    });

    expect(create).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(77, "你好");
    expect(result.current.conversationIndex.selectedId).toBe(77);
    expect(result.current.conversationIndex.draftId).toBe(77);
    expect(selectionStore.read()).toBe(77);
    await waitFor(() =>
      expect(result.current.activeRun?.runId).toBe(sendMessageResponse.run.id),
    );
  });

  it("sends to the already-selected conversation without creating a draft", async () => {
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(), { wrapper: makeWrapper(services) });

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
    const sendMessage = vi.fn(async () => sendMessageResponse);
    const services = createFakeServices({}, { sendMessage });
    const { result } = renderHook(() => useSendProbe(), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("   ");
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps state usable when sendMessage rejects", async () => {
    const create = vi.fn(async () => draft);
    const sendMessage = vi.fn(async () => {
      throw new Error("network");
    });
    const services = createFakeServices({}, { create, sendMessage });
    const { result } = renderHook(() => useSendProbe(), { wrapper: makeWrapper(services) });

    await act(async () => {
      await result.current.send("会失败");
    });

    expect(sendMessage).toHaveBeenCalled();
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
import { useRunStream } from "../runs/useRunStream";
import { selectionStore } from "./selectionStore";

export function useSendMessage() {
  const { conversationIndex } = useAppState();
  const { dispatch, services } = useAppActions();
  const { conversationApi } = services;
  const { start } = useRunStream();

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

### Task 8: StreamingMessage 组件 + 样式

**Files:**
- Create: `frontend/src/messages/StreamingMessage.tsx`
- Modify: `frontend/src/styles/chat.css`
- Test: `frontend/src/messages/StreamingMessage.test.tsx` (Create)

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/StreamingMessage.test.tsx`：

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
  it("renders streamed body text", () => {
    render(<StreamingMessage run={run({ draftText: "Hello world", status: "streaming" })} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders the reasoning block", () => {
    render(<StreamingMessage run={run({ draftReasoning: "在想", status: "streaming" })} />);
    expect(screen.getByText("在想")).toBeInTheDocument();
  });

  it("shows a failure status line", () => {
    render(<StreamingMessage run={run({ draftText: "部分", status: "failed" })} />);
    expect(screen.getByText("生成失败")).toBeInTheDocument();
  });

  it("shows a cancelled status line", () => {
    render(<StreamingMessage run={run({ draftText: "部分", status: "cancelled" })} />);
    expect(screen.getByText("已停止")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/messages/StreamingMessage.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现组件**

创建 `frontend/src/messages/StreamingMessage.tsx`：

```tsx
import type { ActiveRunState } from "../runs/state";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type StreamingMessageProps = { run: NonNullable<ActiveRunState> };

const STATUS_TEXT: Record<string, string | undefined> = {
  failed: "生成失败",
  cancelled: "已停止",
};

export function StreamingMessage({ run }: StreamingMessageProps) {
  const thinking =
    (run.status === "started" || run.status === "streaming") && run.draftText === "";
  const statusText = STATUS_TEXT[run.status];

  return (
    <div className="msg assistant">
      <div style={{ flex: 1, minWidth: 0 }}>
        {run.draftReasoning && (
          <ThinkingBlock content={run.draftReasoning} streaming={thinking} />
        )}
        <Markdown content={run.draftText} />
        {statusText && <div className="run-status">{statusText}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 加 .run-status 样式**

在 `frontend/src/styles/chat.css` 末尾追加：

```css
.run-status {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted, #8a8a85);
}
```

> 若 `chat.css` 中已定义 `--muted` 之外的次要文本变量，沿用该变量替换 `var(--muted, #8a8a85)`。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run src/messages/StreamingMessage.test.tsx`
Expected: PASS（4 个用例全过）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/messages/StreamingMessage.tsx frontend/src/messages/StreamingMessage.test.tsx frontend/src/styles/chat.css
git commit -m "feat(frontend): add streaming assistant message component"
```

---

### Task 9: Composer 接入 onSubmit / disabled

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

describe("Composer", () => {
  it("disables send when empty", () => {
    render(<Composer value="" onChange={() => {}} onSubmit={() => {}} disabled={false} />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("enables send with non-empty input", () => {
    render(<Composer value="hi" onChange={() => {}} onSubmit={() => {}} disabled={false} />);
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("submits on Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={() => {}} onSubmit={onSubmit} disabled={false} />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("does not submit on Shift+Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={() => {}} onSubmit={onSubmit} disabled={false} />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when disabled", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={() => {}} onSubmit={onSubmit} disabled={true} />);
    screen.getByPlaceholderText("有问题，尽管问").focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("clicking send calls onSubmit", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={() => {}} onSubmit={onSubmit} disabled={false} />);
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/ui/Composer.test.tsx`
Expected: FAIL（Composer 还没有 `onSubmit` / `disabled`，Enter 不提交）。

- [ ] **Step 3: 实现 Composer 接线**

把 `frontend/src/ui/Composer.tsx` 改为：

```tsx
import { useEffect, useRef } from "react";

import { Icons } from "./icons";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
};

const MAX_HEIGHT = 240;

export function Composer({ value, onChange, onSubmit, disabled }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const canSend = value.trim() !== "" && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSubmit(value);
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
              submit();
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
            <button
              className="send-btn"
              type="button"
              aria-label="发送"
              disabled={!canSend}
              onClick={submit}
            >
              <Icons.ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/ui/Composer.test.tsx`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/Composer.tsx frontend/src/ui/Composer.test.tsx
git commit -m "feat(frontend): wire composer submit and disabled state"
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
  });
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm exec vitest run src/app/AppShell.test.tsx`
Expected: FAIL（AppShell 尚未接 onSubmit/StreamingMessage，发送无效果）。

- [ ] **Step 4: AppShell 接线**

修改 `frontend/src/app/AppShell.tsx`：

1）import 区补充：

```tsx
import { StreamingMessage } from "../messages/StreamingMessage";
import { useStickToBottom } from "../messages/useStickToBottom";
import { useSendMessage } from "../conversations/useSendMessage";
```

2）把 `const { ui } = useAppState();` 改为：

```tsx
  const { ui, activeRun } = useAppState();
```

3）在 `const [composerValue, setComposerValue] = useState("");` 之后加入发送与滚动接线：

```tsx
  const send = useSendMessage();
  const threadRef = useStickToBottom<HTMLDivElement>([
    detail.messages.length,
    activeRun?.draftText,
    activeRun?.draftReasoning,
    activeRun?.status,
  ]);

  const onSubmit = (text: string) => {
    setComposerValue("");
    void send(text);
  };

  const streaming =
    activeRun != null &&
    activeRun.conversationId === selectedId &&
    (activeRun.status === "queued" ||
      activeRun.status === "started" ||
      activeRun.status === "streaming");
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
            onSubmit={onSubmit}
            disabled={streaming}
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

- [ ] **Step 5:（可选）本地跨域 smoke**

起后端 `uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`（确保 `CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`），前端 `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1 pnpm dev`，登录后发一条消息，确认：思考过程实时显示、正文流式、终态被服务端消息替换、侧栏出现该会话。

---

## 完成标准

- 登录后可在空白态（自动建草稿）或已选中会话发送消息。
- 思考过程与正文实时流式渲染；正文到达时思考区自动收起。
- run 成功后服务端物化的助手消息替换流式气泡，侧栏出现该会话。
- run 失败/流错误时保留 partial、显示「生成失败」、恢复输入。
- 流式中发送按钮禁用；near-bottom 时自动贴底。
- 切换/新建会话清空流式态；流式中途切走，run 终态不污染当前会话详情。
- `pnpm exec vitest run` / `typecheck` / `lint` / `build` 全绿。
