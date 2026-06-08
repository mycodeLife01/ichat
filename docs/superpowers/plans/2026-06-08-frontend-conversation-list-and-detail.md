# 会话列表与详情 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录后进入真实聊天工作台——侧栏展示会话列表、点击只读阅读会话详情（Markdown + 思考过程）、可新建/重命名/删除会话、刷新恢复上次选择；Composer 呈现但发送禁用。

**Architecture:** 在已有单根 reducer + 双 Context 架构上，把 `conversationIndex`/`conversationDetail`/`ui` 三个切片做实，新增 `selectionStore` 持久化与 `useConversationLoader` 副作用编排，并严格复现 `chatapp_demo` 的聊天外壳与消息组件。发送/SSE（step 8）、编辑/重新生成（step 10）、Toast/BottomSheet（step 11）不在本计划。

**Tech Stack:** React 19 + TypeScript + Vite + Vitest + Testing Library + lucide-react + react-markdown/remark-gfm/rehype-sanitize（依赖已在 `package.json`，无需安装）。

**对应 spec：** `docs/superpowers/specs/2026-06-08-frontend-conversation-list-and-detail-design.md`

---

## File Structure

新增/修改文件及职责：

| 文件 | 动作 | 职责 |
|------|------|------|
| `frontend/src/api/conversations.ts` | 修改 | 导出 `ConversationApi` 类型（`ReturnType`） |
| `frontend/src/app/context.ts` | 修改 | `Services` 增加 `conversationApi` |
| `frontend/src/app/AppProvider.tsx` | 修改 | 真实分支装配 `createConversationApi(client)` |
| `frontend/src/test/appHarness.tsx` | 修改 | 新增 `createFakeConversationApi`；`createFakeServices` 接受第二参数 |
| `frontend/src/conversations/state.ts` | 修改 | index/detail 切片做实 feature actions |
| `frontend/src/conversations/state.test.ts` | 创建 | 两个切片 reducer 测试 |
| `frontend/src/ui/state.ts` | 创建 | `UiState` + `uiReducer` + actions（从 store.ts 迁出并扩展） |
| `frontend/src/ui/state.test.ts` | 创建 | ui reducer 测试 |
| `frontend/src/app/store.ts` | 修改 | 引入 ui 切片、扩展 `AppAction` 联合 |
| `frontend/src/conversations/selectionStore.ts` | 创建 | localStorage 持久化当前选择 |
| `frontend/src/conversations/selectionStore.test.ts` | 创建 | selectionStore 测试 |
| `frontend/src/conversations/useConversationLoader.ts` | 修改 | 替换占位，做实副作用编排 |
| `frontend/src/conversations/useConversationLoader.test.tsx` | 创建 | hook 测试 |
| `frontend/src/styles/tokens.css` | 创建 | 共享设计 token（全局） |
| `frontend/src/styles/chat.css` | 创建 | 聊天外壳样式（移植自 demo） |
| `frontend/src/styles/global.css` | 修改 | 引入 tokens；移除无用占位样式 |
| `frontend/src/auth/AuthScreen.css` | 修改 | 移除重复 token 块，复用全局 token |
| `frontend/src/ui/icons.tsx` | 创建 | lucide-react 图标映射 |
| `frontend/src/ui/icons.test.tsx` | 创建 | 图标映射存在性测试 |
| `frontend/src/ui/Wordmark.tsx` | 创建 | 文字标识 |
| `frontend/src/ui/Wordmark.test.tsx` | 创建 | 渲染测试 |
| `frontend/src/messages/Markdown.tsx` | 创建 | 安全 Markdown 渲染 |
| `frontend/src/messages/Markdown.test.tsx` | 创建 | 渲染 + sanitize 测试 |
| `frontend/src/messages/ThinkingBlock.tsx` | 创建 | reasoning 折叠区 |
| `frontend/src/messages/ThinkingBlock.test.tsx` | 创建 | 展开/收起测试 |
| `frontend/src/messages/Message.tsx` | 创建 | 单条消息（用户气泡/助手正文/操作行） |
| `frontend/src/messages/Message.test.tsx` | 创建 | 角色渲染 + 复制 + 禁用按钮测试 |
| `frontend/src/messages/MessageThread.tsx` | 创建 | 消息列表 |
| `frontend/src/messages/MessageThread.test.tsx` | 创建 | 列表渲染测试 |
| `frontend/src/ui/Composer.tsx` | 创建 | 输入框（发送禁用） |
| `frontend/src/ui/Composer.test.tsx` | 创建 | 发送禁用 + 输入测试 |
| `frontend/src/ui/ConfirmDialog.tsx` | 创建 | 确认对话框 |
| `frontend/src/ui/ConfirmDialog.test.tsx` | 创建 | 确认/取消测试 |
| `frontend/src/conversations/Topbar.tsx` | 创建 | 顶栏标题/按钮 |
| `frontend/src/conversations/Topbar.test.tsx` | 创建 | 标题三态测试 |
| `frontend/src/conversations/Sidebar.tsx` | 创建 | 侧栏列表/分组/重命名/删除/账号 |
| `frontend/src/conversations/Sidebar.test.tsx` | 创建 | 分组/重命名/删除确认测试 |
| `frontend/src/app/AppShell.tsx` | 创建 | 工作台外壳，装配 hook + 组件 |
| `frontend/src/app/AppShell.test.tsx` | 创建 | 列表加载 + 选择测试 |
| `frontend/src/app/App.tsx` | 修改 | 已登录分支改用 `AppShell` |
| `frontend/src/app/App.test.tsx` | 修改 | 断言改为 AppShell |
| `frontend/src/app/AuthedPlaceholder.tsx` | 删除 | 被 AppShell 取代 |

**说明（对 spec 的细微调整）：** spec 列了每组件一份 CSS。为减少重复与回归风险，本计划把共享外壳样式集中到单个 `styles/chat.css`（demo 本身即单文件样式），认证页保留独立 `AuthScreen.css`。类名沿用 demo。

---

## Task 1: 把 conversationApi 接入 Services / 测试 harness / AppProvider

**Files:**
- Modify: `frontend/src/api/conversations.ts`
- Modify: `frontend/src/app/context.ts`
- Modify: `frontend/src/app/AppProvider.tsx`
- Modify: `frontend/src/test/appHarness.tsx`

这是纯类型/装配改动，靠现有测试套件守护（不新增专门测试）。

- [ ] **Step 1: 导出 ConversationApi 类型**

在 `frontend/src/api/conversations.ts` 文件末尾、`export const conversationApi = createConversationApi();` 之前，新增：

```ts
export type ConversationApi = ReturnType<typeof createConversationApi>;
```

- [ ] **Step 2: Services 增加 conversationApi**

修改 `frontend/src/app/context.ts`：在顶部 import 区加入

```ts
import type { ConversationApi } from "../api/conversations";
```

把 `Services` 类型改为：

```ts
export type Services = {
  authApi: AuthApi;
  conversationApi: ConversationApi;
};
```

- [ ] **Step 3: AppProvider 真实分支装配 conversationApi**

修改 `frontend/src/app/AppProvider.tsx`：在 import 区加入

```ts
import { createConversationApi } from "../api/conversations";
```

把真实 services 构造改为：

```ts
    const client = new ApiClient({
      onAuthExpired: createAuthExpiryHandler({ dispatch, abort: streamAbort.abort }),
    });
    return {
      authApi: createAuthApi(client),
      conversationApi: createConversationApi(client),
    };
```

- [ ] **Step 4: 测试 harness 提供 fake conversationApi**

修改 `frontend/src/test/appHarness.tsx`，整体替换为：

```tsx
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import type { ConversationApi } from "../api/conversations";
import { AppProvider } from "../app/AppProvider";
import type { AuthApi, Services } from "../app/context";
import {
  authTokenResponse,
  conversationDetailResponse,
  conversationResponse,
  sendMessageResponse,
} from "./apiFixtures";

export function createFakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: async () => authTokenResponse,
    login: async () => authTokenResponse,
    refresh: async () => authTokenResponse,
    logout: async () => ({ status: "ok" }),
    ...overrides,
  };
}

export function createFakeConversationApi(
  overrides: Partial<ConversationApi> = {},
): ConversationApi {
  return {
    list: async () => [],
    create: async () => conversationResponse,
    detail: async () => conversationDetailResponse,
    rename: async () => conversationResponse,
    remove: async () => ({ status: "ok" }),
    sendMessage: async () => sendMessageResponse,
    editAndRegenerate: async () => sendMessageResponse,
    regenerate: async () => sendMessageResponse,
    ...overrides,
  };
}

export function createFakeServices(
  authApi: Partial<AuthApi> = {},
  conversationApi: Partial<ConversationApi> = {},
): Services {
  return {
    authApi: createFakeAuthApi(authApi),
    conversationApi: createFakeConversationApi(conversationApi),
  };
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
): RenderResult {
  return render(<AppProvider services={services}>{ui}</AppProvider>, options);
}
```

- [ ] **Step 5: 修复 context.test.tsx 的手写 services 字面量**

`Services` 现在要求 `conversationApi`，`frontend/src/app/context.test.tsx` 中手写的 `AppActions` 字面量会编译失败。把该字面量的 `services` 行（约第 42 行）改为：

```tsx
      services: {
        authApi: {} as AppActions["services"]["authApi"],
        conversationApi: {} as AppActions["services"]["conversationApi"],
      },
```

- [ ] **Step 6: 运行全量测试确认未回归**

Run: `pnpm --dir frontend exec vitest run`
Expected: 全部通过（既有 61 个测试不受影响）。

- [ ] **Step 7: typecheck**

Run: `pnpm --dir frontend run typecheck`
Expected: 通过。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/conversations.ts frontend/src/app/context.ts frontend/src/app/AppProvider.tsx frontend/src/test/appHarness.tsx frontend/src/app/context.test.tsx
git commit -m "feat(frontend): wire conversationApi into services and test harness"
```

---

## Task 2: conversationIndex 切片做实

**Files:**
- Modify: `frontend/src/conversations/state.ts`
- Modify: `frontend/src/app/store.ts`
- Test: `frontend/src/conversations/state.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/conversations/state.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { conversationResponse } from "../test/apiFixtures";
import {
  conversationIndexReducer,
  initialConversationIndexState,
} from "./state";

describe("conversationIndexReducer", () => {
  it("sets loading then loaded with items", () => {
    const loading = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoading",
    });
    expect(loading.status).toBe("loading");

    const loaded = conversationIndexReducer(loading, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    expect(loaded.status).toBe("idle");
    expect(loaded.items).toEqual([conversationResponse]);
  });

  it("sets error status", () => {
    const next = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listError",
    });
    expect(next.status).toBe("error");
  });

  it("selects a conversation and the new (null) state", () => {
    const selected = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/selected",
      id: 10,
    });
    expect(selected.selectedId).toBe(10);

    const cleared = conversationIndexReducer(selected, {
      type: "conversations/selected",
      id: null,
    });
    expect(cleared.selectedId).toBeNull();
  });

  it("replaces a renamed item in place", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    const renamed = { ...conversationResponse, title: "新标题" };
    const next = conversationIndexReducer(base, {
      type: "conversations/renamed",
      conversation: renamed,
    });
    expect(next.items[0].title).toBe("新标题");
  });

  it("removes an item", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    const next = conversationIndexReducer(base, {
      type: "conversations/removed",
      id: conversationResponse.id,
    });
    expect(next.items).toHaveLength(0);
  });

  it("resets to initial on app/reset", () => {
    const base = conversationIndexReducer(initialConversationIndexState, {
      type: "conversations/listLoaded",
      items: [conversationResponse],
    });
    const next = conversationIndexReducer(base, { type: "app/reset" });
    expect(next).toEqual(initialConversationIndexState);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/conversations/state.test.ts`
Expected: FAIL（reducer 尚未处理这些 action / action 类型未声明，typecheck/运行报错）。

- [ ] **Step 3: 实现 conversationIndex 切片**

修改 `frontend/src/conversations/state.ts`，把 `ConversationIndexState` 之后、`initialConversationIndexState` 之后新增 action 类型，并替换 `conversationIndexReducer`。保留 detail 部分不动（下一任务处理）。最终 index 相关部分为：

```ts
export type ConversationIndexAction =
  | { type: "conversations/listLoading" }
  | { type: "conversations/listLoaded"; items: ConversationResponse[] }
  | { type: "conversations/listError" }
  | { type: "conversations/selected"; id: number | null }
  | { type: "conversations/renamed"; conversation: ConversationResponse }
  | { type: "conversations/removed"; id: number };

export function conversationIndexReducer(
  state: ConversationIndexState,
  action: AppAction,
): ConversationIndexState {
  switch (action.type) {
    case "conversations/listLoading":
      return { ...state, status: "loading" };
    case "conversations/listLoaded":
      return { ...state, items: action.items, status: "idle" };
    case "conversations/listError":
      return { ...state, status: "error" };
    case "conversations/selected":
      return { ...state, selectedId: action.id };
    case "conversations/renamed":
      return {
        ...state,
        items: state.items.map((c) =>
          c.id === action.conversation.id ? action.conversation : c,
        ),
      };
    case "conversations/removed":
      return { ...state, items: state.items.filter((c) => c.id !== action.id) };
    case "app/reset":
      return initialConversationIndexState;
    default:
      return state;
  }
}
```

- [ ] **Step 4: 扩展 store.ts 的 AppAction 联合**

修改 `frontend/src/app/store.ts`。把 conversations import 行改为引入 action 类型：

```ts
import {
  conversationDetailReducer,
  conversationIndexReducer,
  initialConversationDetailState,
  initialConversationIndexState,
  type ConversationDetailState,
  type ConversationIndexAction,
  type ConversationIndexState,
} from "../conversations/state";
```

把 `AppAction` 改为：

```ts
export type AppAction = AuthAction | ConversationIndexAction | AppResetAction;
```

> 注：`ConversationDetailAction` / `UiAction` 在后续任务加入联合。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/conversations/state.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck**

Run: `pnpm --dir frontend run typecheck`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/conversations/state.ts frontend/src/conversations/state.test.ts frontend/src/app/store.ts
git commit -m "feat(frontend): implement conversation index slice actions"
```

---

## Task 3: conversationDetail 切片做实

**Files:**
- Modify: `frontend/src/conversations/state.ts`
- Modify: `frontend/src/app/store.ts`
- Test: `frontend/src/conversations/state.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

在 `frontend/src/conversations/state.test.ts` 末尾追加（并在顶部 import 增补 `conversationDetailReducer`、`initialConversationDetailState`、`conversationDetailResponse`）：

顶部 import 改为：

```ts
import {
  conversationDetailResponse,
  conversationResponse,
} from "../test/apiFixtures";
import {
  conversationDetailReducer,
  conversationIndexReducer,
  initialConversationDetailState,
  initialConversationIndexState,
} from "./state";
```

文件末尾追加：

```ts
describe("conversationDetailReducer", () => {
  const { messages, ...conversation } = conversationDetailResponse;

  it("loads detail into ready state", () => {
    const loading = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoading",
    });
    expect(loading.status).toBe("loading");

    const ready = conversationDetailReducer(loading, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    expect(ready.status).toBe("ready");
    expect(ready.conversation).toEqual(conversation);
    expect(ready.messages).toEqual(messages);
  });

  it("clears to forbidden", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    const next = conversationDetailReducer(ready, {
      type: "conversations/detailForbidden",
    });
    expect(next.status).toBe("forbidden");
    expect(next.conversation).toBeNull();
    expect(next.messages).toEqual([]);
  });

  it("resets to initial on detailReset and app/reset", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    expect(
      conversationDetailReducer(ready, { type: "conversations/detailReset" }),
    ).toEqual(initialConversationDetailState);
    expect(conversationDetailReducer(ready, { type: "app/reset" })).toEqual(
      initialConversationDetailState,
    );
  });

  it("syncs the current conversation on rename", () => {
    const ready = conversationDetailReducer(initialConversationDetailState, {
      type: "conversations/detailLoaded",
      conversation,
      messages,
    });
    const renamed = { ...conversation, title: "改名后" };
    const next = conversationDetailReducer(ready, {
      type: "conversations/renamed",
      conversation: renamed,
    });
    expect(next.conversation?.title).toBe("改名后");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/conversations/state.test.ts`
Expected: FAIL（detail reducer 仍是占位）。

- [ ] **Step 3: 实现 detail 切片**

修改 `frontend/src/conversations/state.ts`，新增 detail action 类型并替换 `conversationDetailReducer`：

```ts
export type ConversationDetailAction =
  | { type: "conversations/detailLoading" }
  | {
      type: "conversations/detailLoaded";
      conversation: ConversationResponse;
      messages: MessageResponse[];
    }
  | { type: "conversations/detailForbidden" }
  | { type: "conversations/detailReset" };

export function conversationDetailReducer(
  state: ConversationDetailState,
  action: AppAction,
): ConversationDetailState {
  switch (action.type) {
    case "conversations/detailLoading":
      return { ...state, status: "loading" };
    case "conversations/detailLoaded":
      return {
        conversation: action.conversation,
        messages: action.messages,
        status: "ready",
      };
    case "conversations/detailForbidden":
      return { conversation: null, messages: [], status: "forbidden" };
    case "conversations/detailReset":
      return initialConversationDetailState;
    case "conversations/renamed":
      return state.conversation && state.conversation.id === action.conversation.id
        ? { ...state, conversation: action.conversation }
        : state;
    case "app/reset":
      return initialConversationDetailState;
    default:
      return state;
  }
}
```

- [ ] **Step 4: 把 ConversationDetailAction 加入 AppAction**

修改 `frontend/src/app/store.ts`：import 增补 `type ConversationDetailAction`，并把联合改为：

```ts
export type AppAction =
  | AuthAction
  | ConversationIndexAction
  | ConversationDetailAction
  | AppResetAction;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --dir frontend exec vitest run src/conversations/state.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/conversations/state.ts frontend/src/conversations/state.test.ts frontend/src/app/store.ts
git commit -m "feat(frontend): implement conversation detail slice actions"
```

---

## Task 4: ui 切片迁出并扩展

**Files:**
- Create: `frontend/src/ui/state.ts`
- Create: `frontend/src/ui/state.test.ts`
- Modify: `frontend/src/app/store.ts`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/ui/state.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { initialUiState, uiReducer } from "./state";

describe("uiReducer", () => {
  it("toggles the mobile sidebar", () => {
    const open = uiReducer(initialUiState, { type: "ui/toggleMobileSidebar" });
    expect(open.mobileSidebarOpen).toBe(true);
  });

  it("sets the mobile sidebar explicitly", () => {
    const open = uiReducer(initialUiState, { type: "ui/setMobileSidebar", open: true });
    expect(open.mobileSidebarOpen).toBe(true);
    const closed = uiReducer(open, { type: "ui/setMobileSidebar", open: false });
    expect(closed.mobileSidebarOpen).toBe(false);
  });

  it("toggles the desktop sidebar collapse", () => {
    const collapsed = uiReducer(initialUiState, { type: "ui/toggleSidebarCollapsed" });
    expect(collapsed.sidebarCollapsed).toBe(true);
  });

  it("opens and closes the confirm dialog", () => {
    const open = uiReducer(initialUiState, {
      type: "ui/openConfirm",
      dialog: { kind: "deleteConversation", conversationId: 7 },
    });
    expect(open.confirmDialog).toEqual({ kind: "deleteConversation", conversationId: 7 });
    const closed = uiReducer(open, { type: "ui/closeConfirm" });
    expect(closed.confirmDialog).toBeNull();
  });

  it("resets on app/reset", () => {
    const dirty = uiReducer(initialUiState, { type: "ui/toggleMobileSidebar" });
    expect(uiReducer(dirty, { type: "app/reset" })).toEqual(initialUiState);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/ui/state.test.ts`
Expected: FAIL（`./state` 不存在）。

- [ ] **Step 3: 创建 ui 切片**

创建 `frontend/src/ui/state.ts`：

```ts
import type { AppAction } from "../app/store";

export type ConfirmDialogState = {
  kind: "deleteConversation";
  conversationId: number;
};

export type UiState = {
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  confirmDialog: ConfirmDialogState | null;
};

export const initialUiState: UiState = {
  mobileSidebarOpen: false,
  sidebarCollapsed: false,
  confirmDialog: null,
};

export type UiAction =
  | { type: "ui/toggleMobileSidebar" }
  | { type: "ui/setMobileSidebar"; open: boolean }
  | { type: "ui/toggleSidebarCollapsed" }
  | { type: "ui/openConfirm"; dialog: ConfirmDialogState }
  | { type: "ui/closeConfirm" };

export function uiReducer(state: UiState, action: AppAction): UiState {
  switch (action.type) {
    case "ui/toggleMobileSidebar":
      return { ...state, mobileSidebarOpen: !state.mobileSidebarOpen };
    case "ui/setMobileSidebar":
      return { ...state, mobileSidebarOpen: action.open };
    case "ui/toggleSidebarCollapsed":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "ui/openConfirm":
      return { ...state, confirmDialog: action.dialog };
    case "ui/closeConfirm":
      return { ...state, confirmDialog: null };
    case "app/reset":
      return initialUiState;
    default:
      return state;
  }
}
```

- [ ] **Step 4: store.ts 改用 ui 切片**

修改 `frontend/src/app/store.ts`：

1. 新增 import：

```ts
import { initialUiState, uiReducer, type UiAction, type UiState } from "../ui/state";
```

2. 删除原有的 `export type UiState = ...`、`const initialUiState: UiState = ...`、`function uiReducer(...) {...}` 三处内联定义。

3. `AppAction` 联合加入 `UiAction`：

```ts
export type AppAction =
  | AuthAction
  | ConversationIndexAction
  | ConversationDetailAction
  | UiAction
  | AppResetAction;
```

4. `initialState.ui` 仍为 `initialUiState`（现在来自 import），`rootReducer` 的 `ui: uiReducer(state.ui, action)` 不变。

> `ComposerState` 与内联 `composerReducer` 保持不动。

- [ ] **Step 5: 运行 ui 与 store 测试**

Run: `pnpm --dir frontend exec vitest run src/ui/state.test.ts src/app/store.test.ts`
Expected: PASS（store.test 中 `reset.ui` 仍等于 `initialState.ui`）。

- [ ] **Step 6: typecheck**

Run: `pnpm --dir frontend run typecheck`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/state.ts frontend/src/ui/state.test.ts frontend/src/app/store.ts
git commit -m "feat(frontend): extract and extend ui state slice"
```

---

## Task 5: selectionStore 选择持久化

**Files:**
- Create: `frontend/src/conversations/selectionStore.ts`
- Test: `frontend/src/conversations/selectionStore.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/conversations/selectionStore.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectionStore } from "./selectionStore";

describe("selectionStore", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("returns null when empty", () => {
    expect(selectionStore.read()).toBeNull();
  });

  it("saves and reads an id", () => {
    selectionStore.save(42);
    expect(selectionStore.read()).toBe(42);
  });

  it("clears the id", () => {
    selectionStore.save(42);
    selectionStore.clear();
    expect(selectionStore.read()).toBeNull();
  });

  it("drops a corrupt value", () => {
    localStorage.setItem("ichat.selectedConversationId", "not-a-number");
    expect(selectionStore.read()).toBeNull();
    expect(localStorage.getItem("ichat.selectedConversationId")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/conversations/selectionStore.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 selectionStore**

创建 `frontend/src/conversations/selectionStore.ts`：

```ts
const SELECTION_STORAGE_KEY = "ichat.selectedConversationId";

export type SelectionStore = {
  read(): number | null;
  save(id: number): void;
  clear(): void;
};

export const selectionStore: SelectionStore = {
  read() {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      localStorage.removeItem(SELECTION_STORAGE_KEY);
      return null;
    }
    return value;
  },
  save(id) {
    localStorage.setItem(SELECTION_STORAGE_KEY, String(id));
  },
  clear() {
    localStorage.removeItem(SELECTION_STORAGE_KEY);
  },
};
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/conversations/selectionStore.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/conversations/selectionStore.ts frontend/src/conversations/selectionStore.test.ts
git commit -m "feat(frontend): add conversation selection persistence"
```

---

## Task 6: useConversationLoader 副作用编排

**Files:**
- Modify: `frontend/src/conversations/useConversationLoader.ts`
- Test: `frontend/src/conversations/useConversationLoader.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/conversations/useConversationLoader.test.tsx`：

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { conversationDetailResponse, conversationResponse } from "../test/apiFixtures";
import { createFakeServices, makeWrapper } from "../test/appHarness";
import { selectionStore } from "./selectionStore";
import { useConversationLoader } from "./useConversationLoader";

describe("useConversationLoader", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads the list", async () => {
    const services = createFakeServices({}, { list: async () => [conversationResponse] });
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });

    expect(result.current.items).toEqual([conversationResponse]);
  });

  it("selects a conversation and persists the id", async () => {
    const services = createFakeServices(
      {},
      { detail: async () => conversationDetailResponse },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.selectConversation(conversationResponse.id);
    });

    expect(result.current.selectedId).toBe(conversationResponse.id);
    expect(result.current.detailStatus).toBe("ready");
    expect(selectionStore.read()).toBe(conversationResponse.id);
  });

  it("clears selection when detail is forbidden (404)", async () => {
    selectionStore.save(999);
    const services = createFakeServices(
      {},
      {
        detail: async () => {
          throw new ApiError({ status: 404 });
        },
      },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.selectConversation(999);
    });

    expect(result.current.selectedId).toBeNull();
    expect(result.current.detailStatus).toBe("forbidden");
    expect(selectionStore.read()).toBeNull();
  });

  it("new conversation resets detail and clears persistence", async () => {
    selectionStore.save(5);
    const services = createFakeServices();
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    act(() => {
      result.current.newConversation();
    });

    expect(result.current.selectedId).toBeNull();
    expect(result.current.detailStatus).toBe("idle");
    expect(selectionStore.read()).toBeNull();
  });

  it("renames a conversation", async () => {
    const renamed = { ...conversationResponse, title: "新名" };
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        rename: async () => renamed,
      },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
    });
    await act(async () => {
      await result.current.renameConversation(conversationResponse.id, "新名");
    });

    expect(result.current.items[0].title).toBe("新名");
  });

  it("deletes the selected conversation and falls back to empty", async () => {
    const remove = vi.fn(async () => ({ status: "ok" }));
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse], detail: async () => conversationDetailResponse, remove },
    );
    const { result } = renderHook(() => useConversationLoader(), {
      wrapper: makeWrapper(services),
    });

    await act(async () => {
      await result.current.loadList();
      await result.current.selectConversation(conversationResponse.id);
    });
    await act(async () => {
      await result.current.deleteConversation(conversationResponse.id);
    });

    expect(remove).toHaveBeenCalledWith(conversationResponse.id);
    expect(result.current.items).toHaveLength(0);
    expect(result.current.selectedId).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/conversations/useConversationLoader.test.tsx`
Expected: FAIL（占位 hook 抛错）。

- [ ] **Step 3: 实现 hook**

整体替换 `frontend/src/conversations/useConversationLoader.ts`：

```ts
import { useCallback } from "react";

import { ApiError } from "../api/errors";
import { useAppActions, useAppState } from "../app/context";
import { selectionStore } from "./selectionStore";

export function useConversationLoader() {
  const { conversationIndex, conversationDetail } = useAppState();
  const { dispatch, services } = useAppActions();
  const { conversationApi } = services;

  const loadList = useCallback(async () => {
    dispatch({ type: "conversations/listLoading" });
    try {
      const items = await conversationApi.list();
      dispatch({ type: "conversations/listLoaded", items });
    } catch {
      dispatch({ type: "conversations/listError" });
    }
  }, [dispatch, conversationApi]);

  const newConversation = useCallback(() => {
    dispatch({ type: "conversations/selected", id: null });
    dispatch({ type: "conversations/detailReset" });
    dispatch({ type: "ui/setMobileSidebar", open: false });
    selectionStore.clear();
  }, [dispatch]);

  const selectConversation = useCallback(
    async (id: number) => {
      dispatch({ type: "conversations/selected", id });
      dispatch({ type: "conversations/detailLoading" });
      dispatch({ type: "ui/setMobileSidebar", open: false });
      try {
        const detail = await conversationApi.detail(id);
        const { messages, ...conversation } = detail;
        dispatch({ type: "conversations/detailLoaded", conversation, messages });
        selectionStore.save(id);
      } catch (error) {
        // 403/404：失效选择，静默清理回空白态。其它错误也归为 forbidden 简化态。
        dispatch({ type: "conversations/detailForbidden" });
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          dispatch({ type: "conversations/selected", id: null });
          selectionStore.clear();
        }
      }
    },
    [dispatch, conversationApi],
  );

  const renameConversation = useCallback(
    async (id: number, title: string) => {
      const trimmed = title.trim();
      if (trimmed === "") return;
      const conversation = await conversationApi.rename(id, trimmed);
      dispatch({ type: "conversations/renamed", conversation });
    },
    [dispatch, conversationApi],
  );

  const deleteConversation = useCallback(
    async (id: number) => {
      await conversationApi.remove(id);
      const remaining = conversationIndex.items.filter((c) => c.id !== id);
      dispatch({ type: "conversations/removed", id });
      dispatch({ type: "ui/closeConfirm" });
      if (conversationIndex.selectedId === id) {
        if (remaining.length > 0) {
          await selectConversation(remaining[0].id);
        } else {
          newConversation();
        }
      }
    },
    [dispatch, conversationApi, conversationIndex, selectConversation, newConversation],
  );

  return {
    items: conversationIndex.items,
    selectedId: conversationIndex.selectedId,
    listStatus: conversationIndex.status,
    detail: conversationDetail,
    detailStatus: conversationDetail.status,
    loadList,
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/conversations/useConversationLoader.test.tsx`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run: `pnpm --dir frontend run typecheck`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/conversations/useConversationLoader.ts frontend/src/conversations/useConversationLoader.test.tsx
git commit -m "feat(frontend): implement useConversationLoader orchestration"
```

---

## Task 7: 设计 token 与聊天样式

**Files:**
- Create: `frontend/src/styles/tokens.css`
- Create: `frontend/src/styles/chat.css`
- Modify: `frontend/src/styles/global.css`
- Modify: `frontend/src/auth/AuthScreen.css`

纯样式任务，无单元测试；靠 build 与既有 auth 测试守护。

- [ ] **Step 1: 创建 tokens.css**

创建 `frontend/src/styles/tokens.css`（把 demo 的 `:root` 与原 Tweaks 注入项固化为常量）：

```css
/* Shared design tokens — warm-neutral light theme, ported from chatapp_demo. */
:root {
  --bg: #fbfbfa;
  --bg-sunken: #f4f3f0;
  --bg-raised: #ffffff;
  --bg-hover: rgba(20, 20, 19, 0.04);
  --bg-active: rgba(20, 20, 19, 0.07);

  --fg: #1a1a19;
  --fg-muted: #6b6a66;
  --fg-subtle: #95938e;
  --fg-faint: #b8b6b0;

  --border: rgba(20, 20, 19, 0.08);
  --border-strong: rgba(20, 20, 19, 0.14);
  --border-focus: rgba(20, 20, 19, 0.55);

  --accent: #1a1a19;
  --accent-fg: #fbfbfa;
  --accent-soft: rgba(20, 20, 19, 0.07);

  --danger: #b54a2e;
  --danger-soft: rgba(181, 74, 46, 0.08);

  --radius-sm: 4px;
  --radius: 6px;
  --radius-lg: 10px;

  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans CN", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-serif: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", serif;

  /* Fixed values (previously Tweaks-driven). */
  --density: 1.1;
  --reading-width: 820px;
  --sidebar-width: 280px;
  --row-pad-y: calc(7px * var(--density));
  --row-pad-x: calc(10px * var(--density));
  --msg-gap: calc(32px * var(--density));

  --composer-radius: 18px;
  --send-radius: 18px;
  --history-radius: 6px;
  --menu-radius: 8px;
  --user-bubble-radius: 10px;
  --composer-max-height: 240px;
  --composer-border-width: 1px;

  --scrollbar-thumb: rgba(20, 20, 19, 0.18);
  --scrollbar-thumb-hover: rgba(20, 20, 19, 0.32);
}
```

- [ ] **Step 2: 创建 chat.css（从 demo 移植）**

创建 `frontend/src/styles/chat.css`。从 `chatapp_demo/styles.css` 复制以下行区间，**按顺序**拼接到该文件（这些区间不含 Tweaks/Auth/BottomSheet/Toast，变量均已在 tokens.css 定义）：

1. 全局滚动条与 button/input 重置：第 65–118 行（`* { scrollbar-width }` 到 `[role="button"]:focus-visible {...}`）。
2. App shell + sidebar + main + 空白态 + 消息 + thinking + caret + status pill + markdown + composer + 按钮：第 120–900 行（`.app {` 到 `.primary-btn:disabled {...}`）。
3. 移动端：第 1200–1252 行（`.mobile-only` 到 `@media (max-width: 760px)` 块结束的 `}`）。
4. 确认框：第 1304–1338 行（`.dialog-backdrop {` 到 `.dialog-actions {...}`）。

复制后在文件顶部加一行注释：

```css
/* Chat workspace styles, ported verbatim from chatapp_demo/styles.css. */
```

> 不复制：`:root`（已在 tokens.css）、`.auth-*`（在 AuthScreen.css）、`.sheet-*`（step 11）、`.toast`（step 11）、`.welcome-pill*` 之外的 tweaks 注释行。`.welcome-pill` 样式可保留也可省略（本步欢迎态不显示 pills）。

- [ ] **Step 3: global.css 引入 tokens、清理占位样式**

整体替换 `frontend/src/styles/global.css`：

```css
@import "./tokens.css";

* {
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

#root {
  height: 100%;
}

button,
input,
textarea {
  font: inherit;
}
```

> 删除了原 `.app-shell` / `.app-card` / `.app-eyebrow` 等占位样式（本步产生的孤儿，无引用）。

- [ ] **Step 4: AuthScreen.css 去掉重复 token 块**

修改 `frontend/src/auth/AuthScreen.css`：删除 `.auth-shell` 选择器内重复声明的设计 token 行（`--bg` 到 `--font-mono` 那一段，即第 5–18 行那批 `--xxx:` 声明），保留其余布局属性（`position: relative;` 起）。token 现由全局 `:root` 提供。`.wordmark` 的通用定义已在 chat.css 提供，可保留 AuthScreen.css 中的 `.auth-brand .wordmark` 覆盖。

- [ ] **Step 5: 运行既有测试与 build**

Run: `pnpm --dir frontend exec vitest run && pnpm --dir frontend run build`
Expected: 测试全绿；build 成功（CSS 正确解析）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/styles/chat.css frontend/src/styles/global.css frontend/src/auth/AuthScreen.css
git commit -m "feat(frontend): add shared design tokens and chat styles"
```

---

## Task 8: icons 与 Wordmark

**Files:**
- Create: `frontend/src/ui/icons.tsx`
- Create: `frontend/src/ui/icons.test.tsx`
- Create: `frontend/src/ui/Wordmark.tsx`
- Create: `frontend/src/ui/Wordmark.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/ui/icons.test.tsx`：

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Icons } from "./icons";

describe("Icons", () => {
  it("exposes the icons used across the chat shell", () => {
    const names = [
      "More", "Pen", "Pencil", "Trash", "Plus", "PanelLeft", "LogOut",
      "Menu", "Chevron", "Copy", "Refresh", "ArrowUp", "Mic", "Stop", "Close",
    ] as const;
    for (const name of names) {
      expect(Icons[name]).toBeDefined();
    }
  });

  it("renders an icon", () => {
    const { container } = render(<Icons.Plus size={14} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
```

创建 `frontend/src/ui/Wordmark.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("renders the iChat wordmark", () => {
    render(<Wordmark />);
    expect(screen.getByText("iChat")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/ui/icons.test.tsx src/ui/Wordmark.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 icons 与 Wordmark**

创建 `frontend/src/ui/icons.tsx`：

```tsx
import {
  ArrowUp,
  ChevronDown,
  Copy,
  LogOut,
  Menu,
  Mic,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  PenLine,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from "lucide-react";

export const Icons = {
  More: MoreHorizontal,
  Pen: PenLine,
  Pencil: Pencil,
  Trash: Trash2,
  Plus: Plus,
  PanelLeft: PanelLeft,
  LogOut: LogOut,
  Menu: Menu,
  Chevron: ChevronDown,
  Copy: Copy,
  Refresh: RefreshCw,
  ArrowUp: ArrowUp,
  Mic: Mic,
  Stop: Square,
  Close: X,
};
```

创建 `frontend/src/ui/Wordmark.tsx`：

```tsx
type WordmarkProps = { size?: number };

export function Wordmark({ size = 17 }: WordmarkProps) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      iChat
    </span>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/ui/icons.test.tsx src/ui/Wordmark.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/icons.tsx frontend/src/ui/icons.test.tsx frontend/src/ui/Wordmark.tsx frontend/src/ui/Wordmark.test.tsx
git commit -m "feat(frontend): add icon map and wordmark"
```

---

## Task 9: Markdown 安全渲染

**Files:**
- Create: `frontend/src/messages/Markdown.tsx`
- Test: `frontend/src/messages/Markdown.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/Markdown.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders GFM content", () => {
    const { container } = render(<Markdown content={"# 标题\n\n- 一\n- 二"} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("does not render raw/dangerous html", () => {
    // react-markdown ignores raw HTML by default (no rehype-raw), and
    // rehype-sanitize is a second guard; the dangerous <img> must not appear.
    const { container } = render(
      <Markdown content={"<img src=x onerror=alert(1) />\n\n正常文本"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("正常文本")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/messages/Markdown.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 Markdown**

创建 `frontend/src/messages/Markdown.tsx`：

```tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

type MarkdownProps = { content: string };

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="body md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/messages/Markdown.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/Markdown.tsx frontend/src/messages/Markdown.test.tsx
git commit -m "feat(frontend): add sanitized markdown renderer"
```

---

## Task 10: ThinkingBlock 思考折叠区

**Files:**
- Create: `frontend/src/messages/ThinkingBlock.tsx`
- Test: `frontend/src/messages/ThinkingBlock.test.tsx`

本步只用 block 模式、历史消息（无流式）。`streaming` 入参保留以便 step 8 复用。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/ThinkingBlock.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("starts collapsed and shows the done label", () => {
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    expect(screen.getByText("已思考")).toBeInTheDocument();
  });

  it("toggles open on click", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock content="推理内容" streaming={false} />);
    const header = screen.getByRole("button", { name: /已思考/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/messages/ThinkingBlock.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 ThinkingBlock**

创建 `frontend/src/messages/ThinkingBlock.tsx`：

```tsx
import { useState } from "react";

import { Icons } from "../ui/icons";

type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
};

export function ThinkingBlock({ content, streaming }: ThinkingBlockProps) {
  const [open, setOpen] = useState(streaming);

  return (
    <div className={`thinking${open ? "" : " collapsed"}`}>
      <div
        className="thinking-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        {streaming && <span className="pulse" />}
        <Icons.Chevron size={11} className="chev" />
        {streaming ? "思考中…" : "已思考"}
      </div>
      <div className="thinking-body">{content}</div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/messages/ThinkingBlock.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/ThinkingBlock.tsx frontend/src/messages/ThinkingBlock.test.tsx
git commit -m "feat(frontend): add thinking block component"
```

---

## Task 11: Message 单条消息

**Files:**
- Create: `frontend/src/messages/Message.tsx`
- Test: `frontend/src/messages/Message.test.tsx`

用户消息：气泡 + 复制 + 编辑（禁用）。助手消息：思考区 + Markdown + 复制 + 重新生成（禁用）。本步移动端也显示内联复制（偏差 2）。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/Message.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

const userMessage: MessageResponse = {
  id: 1,
  conversation_id: 10,
  run_id: null,
  role: "user",
  content: "你好",
  reasoning: null,
  position: 1,
  created_at: "2026-06-08T10:00:00Z",
};

const assistantMessage: MessageResponse = {
  id: 2,
  conversation_id: 10,
  run_id: 100,
  role: "assistant",
  content: "**回答**正文",
  reasoning: "我的推理",
  position: 2,
  created_at: "2026-06-08T10:00:01Z",
};

describe("Message", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders a user bubble", () => {
    render(<Message message={userMessage} />);
    expect(screen.getByText("你好")).toBeInTheDocument();
  });

  it("renders assistant markdown and thinking", () => {
    render(<Message message={assistantMessage} />);
    expect(screen.getByText("回答")).toBeInTheDocument(); // bold rendered
    expect(screen.getByText("已思考")).toBeInTheDocument();
  });

  it("copies content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const user = userEvent.setup();

    render(<Message message={userMessage} />);
    await user.click(screen.getByRole("button", { name: /复制/ }));

    expect(writeText).toHaveBeenCalledWith("你好");
  });

  it("disables edit/regenerate this step", () => {
    render(<Message message={assistantMessage} />);
    expect(screen.getByRole("button", { name: /重新生成/ })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/messages/Message.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 Message**

创建 `frontend/src/messages/Message.tsx`：

```tsx
import type { MessageResponse } from "../api/types";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type MessageProps = { message: MessageResponse };

const MUTATE_DISABLED_HINT = "即将接入";

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

export function Message({ message }: MessageProps) {
  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
        <div className="msg-actions">
          <button className="msg-action" onClick={() => copy(message.content)}>
            <Icons.Copy size={12} />
            复制
          </button>
          <button className="msg-action" disabled title={MUTATE_DISABLED_HINT}>
            <Icons.Pencil size={12} />
            编辑并重发
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div style={{ flex: 1, minWidth: 0 }}>
        {message.reasoning && (
          <ThinkingBlock content={message.reasoning} streaming={false} />
        )}
        <Markdown content={message.content} />
        <div className="msg-actions">
          <button className="msg-action" onClick={() => copy(message.content)}>
            <Icons.Copy size={12} />
            复制
          </button>
          <button className="msg-action" disabled title={MUTATE_DISABLED_HINT}>
            <Icons.Refresh size={12} />
            重新生成
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/messages/Message.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/Message.tsx frontend/src/messages/Message.test.tsx
git commit -m "feat(frontend): add message component (read-only)"
```

---

## Task 12: MessageThread 消息列表

**Files:**
- Create: `frontend/src/messages/MessageThread.tsx`
- Test: `frontend/src/messages/MessageThread.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/messages/MessageThread.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MessageResponse } from "../api/types";
import { MessageThread } from "./MessageThread";

const messages: MessageResponse[] = [
  {
    id: 1, conversation_id: 10, run_id: null, role: "user",
    content: "问题", reasoning: null, position: 1, created_at: "2026-06-08T10:00:00Z",
  },
  {
    id: 2, conversation_id: 10, run_id: 100, role: "assistant",
    content: "答案", reasoning: null, position: 2, created_at: "2026-06-08T10:00:01Z",
  },
];

describe("MessageThread", () => {
  it("renders all messages", () => {
    render(<MessageThread messages={messages} />);
    expect(screen.getByText("问题")).toBeInTheDocument();
    expect(screen.getByText("答案")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/messages/MessageThread.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 MessageThread**

创建 `frontend/src/messages/MessageThread.tsx`：

```tsx
import type { MessageResponse } from "../api/types";
import { Message } from "./Message";

type MessageThreadProps = { messages: MessageResponse[] };

export function MessageThread({ messages }: MessageThreadProps) {
  return (
    <div className="thread-inner">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/messages/MessageThread.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/messages/MessageThread.tsx frontend/src/messages/MessageThread.test.tsx
git commit -m "feat(frontend): add message thread list"
```

---

## Task 13: Composer（发送禁用）

**Files:**
- Create: `frontend/src/ui/Composer.tsx`
- Test: `frontend/src/ui/Composer.test.tsx`

发送禁用：发送按钮始终 disabled；Enter 不发送。键盘/IME 结构保留以便 step 8 接上。装饰按钮（附件/模式/语音）为静态。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/ui/Composer.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

describe("Composer", () => {
  it("renders the placeholder and a disabled send button", () => {
    render(<Composer value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText("有问题，尽管问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("calls onChange when typing", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Composer value="" onChange={onChange} />);
    await user.type(screen.getByPlaceholderText("有问题，尽管问"), "x");
    expect(onChange).toHaveBeenCalled();
  });

  it("does not submit on Enter this step", async () => {
    const user = userEvent.setup();
    render(<Composer value="hi" onChange={() => {}} />);
    const textarea = screen.getByPlaceholderText("有问题，尽管问");
    textarea.focus();
    await user.keyboard("{Enter}");
    // No throw / no send handler exists; send button stays disabled.
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/ui/Composer.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 Composer**

创建 `frontend/src/ui/Composer.tsx`：

```tsx
import { useEffect, useRef } from "react";

import { Icons } from "./icons";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
};

const MAX_HEIGHT = 240;

// Send is intentionally disabled this step; SSE submit lands in step 8.
export function Composer({ value, onChange }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

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
            // Keyboard wiring reserved for step 8; Enter must not submit yet.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
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
            <button className="send-btn" type="button" aria-label="发送" disabled>
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

Run: `pnpm --dir frontend exec vitest run src/ui/Composer.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/Composer.tsx frontend/src/ui/Composer.test.tsx
git commit -m "feat(frontend): add composer shell with send disabled"
```

---

## Task 14: ConfirmDialog

**Files:**
- Create: `frontend/src/ui/ConfirmDialog.tsx`
- Test: `frontend/src/ui/ConfirmDialog.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/ui/ConfirmDialog.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders title and body", () => {
    render(
      <ConfirmDialog
        title="删除对话？"
        body="无法恢复。"
        confirmLabel="删除"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("删除对话？")).toBeInTheDocument();
    expect(screen.getByText("无法恢复。")).toBeInTheDocument();
  });

  it("invokes confirm and cancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        title="t"
        body="b"
        confirmLabel="删除"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/ui/ConfirmDialog.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 ConfirmDialog**

创建 `frontend/src/ui/ConfirmDialog.tsx`：

```tsx
type ConfirmDialogProps = {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="dialog-actions">
          <button className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="primary-btn"
            style={destructive ? { background: "var(--danger)" } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/ui/ConfirmDialog.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/ConfirmDialog.tsx frontend/src/ui/ConfirmDialog.test.tsx
git commit -m "feat(frontend): add confirm dialog"
```

---

## Task 15: Topbar

**Files:**
- Create: `frontend/src/conversations/Topbar.tsx`
- Test: `frontend/src/conversations/Topbar.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/conversations/Topbar.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Topbar } from "./Topbar";

const noop = () => {};

describe("Topbar", () => {
  it("shows the title", () => {
    render(
      <Topbar
        title="我的对话"
        titlePending={false}
        isMobile={false}
        sidebarCollapsed={false}
        onOpenMobile={noop}
        onToggleSidebar={noop}
        onNewMobile={noop}
      />,
    );
    expect(screen.getByText("我的对话")).toBeInTheDocument();
  });

  it("falls back to 新对话 when title empty", () => {
    render(
      <Topbar
        title={null}
        titlePending={false}
        isMobile={false}
        sidebarCollapsed={false}
        onOpenMobile={noop}
        onToggleSidebar={noop}
        onNewMobile={noop}
      />,
    );
    expect(screen.getByText("新对话")).toBeInTheDocument();
  });

  it("shows a skeleton while title pending", () => {
    const { container } = render(
      <Topbar
        title={null}
        titlePending
        isMobile={false}
        sidebarCollapsed={false}
        onOpenMobile={noop}
        onToggleSidebar={noop}
        onNewMobile={noop}
      />,
    );
    expect(container.querySelector(".title-skeleton")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/conversations/Topbar.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 Topbar**

创建 `frontend/src/conversations/Topbar.tsx`：

```tsx
import { Icons } from "../ui/icons";

type TopbarProps = {
  title: string | null;
  titlePending: boolean;
  isMobile: boolean;
  sidebarCollapsed: boolean;
  onOpenMobile: () => void;
  onToggleSidebar: () => void;
  onNewMobile: () => void;
};

export function Topbar({
  title,
  titlePending,
  isMobile,
  sidebarCollapsed,
  onOpenMobile,
  onToggleSidebar,
  onNewMobile,
}: TopbarProps) {
  return (
    <header className="topbar">
      {isMobile ? (
        <button className="icon-btn" aria-label="打开历史" onClick={onOpenMobile}>
          <Icons.Menu size={16} />
        </button>
      ) : sidebarCollapsed ? (
        <button className="icon-btn" aria-label="展开侧栏" onClick={onToggleSidebar}>
          <Icons.PanelLeft size={15} />
        </button>
      ) : null}

      {titlePending ? (
        <span className="title muted">
          <span className="title-skeleton" style={{ width: 120, verticalAlign: "middle" }} />
        </span>
      ) : (
        <span className={`title${title ? "" : " muted"}`}>{title || "新对话"}</span>
      )}

      {isMobile && (
        <button className="icon-btn" aria-label="新建对话" onClick={onNewMobile}>
          <Icons.Plus size={16} />
        </button>
      )}
    </header>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/conversations/Topbar.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/conversations/Topbar.tsx frontend/src/conversations/Topbar.test.tsx
git commit -m "feat(frontend): add topbar"
```

---

## Task 16: Sidebar

**Files:**
- Create: `frontend/src/conversations/Sidebar.tsx`
- Test: `frontend/src/conversations/Sidebar.test.tsx`

侧栏负责：品牌行、新建、按日期分组、行内重命名、行菜单（重命名/删除）、空列表占位、账号/退出、移动抽屉+遮罩。删除经 props 回调（实际确认框由 AppShell 管理 ui.confirmDialog）。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/conversations/Sidebar.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConversationResponse } from "../api/types";
import { Sidebar } from "./Sidebar";

function makeConversation(
  id: number,
  title: string,
  updatedAt: string,
): ConversationResponse {
  return {
    id,
    title,
    activated_at: updatedAt,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

const today = new Date().toISOString();

function baseProps() {
  return {
    items: [makeConversation(1, "今天的对话", today)],
    selectedId: 1,
    user: { email: "a@b.com", name: "alice" },
    isMobile: false,
    collapsed: false,
    mobileOpen: false,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(),
    onRequestDelete: vi.fn(),
    onLogout: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onCloseMobile: vi.fn(),
  };
}

describe("Sidebar", () => {
  it("groups conversations and renders rows", () => {
    render(<Sidebar {...baseProps()} />);
    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText("今天的对话")).toBeInTheDocument();
  });

  it("shows empty placeholder when no conversations", () => {
    render(<Sidebar {...baseProps()} items={[]} />);
    expect(
      screen.getByText(/还没有已保存的对话/),
    ).toBeInTheDocument();
  });

  it("renames in place on Enter", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByDisplayValue("今天的对话");
    await user.clear(input);
    await user.type(input, "新名字{Enter}");

    expect(props.onRename).toHaveBeenCalledWith(1, "新名字");
  });

  it("requests delete via the row menu", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("button", { name: "删除对话" }));

    expect(props.onRequestDelete).toHaveBeenCalledWith(1);
  });

  it("logs out", async () => {
    const props = baseProps();
    const user = userEvent.setup();
    render(<Sidebar {...props} />);
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(props.onLogout).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/conversations/Sidebar.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 实现 Sidebar**

创建 `frontend/src/conversations/Sidebar.tsx`：

```tsx
import { useEffect, useMemo, useState } from "react";

import type { ConversationResponse } from "../api/types";
import { Icons } from "../ui/icons";
import { Wordmark } from "../ui/Wordmark";

export type SidebarUser = { email: string; name: string };

type SidebarProps = {
  items: ConversationResponse[];
  selectedId: number | null;
  user: SidebarUser | null;
  isMobile: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onRequestDelete: (id: number) => void;
  onLogout: () => void;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
};

type Groups = {
  today: ConversationResponse[];
  yesterday: ConversationResponse[];
  older: ConversationResponse[];
};

function groupByDate(items: ConversationResponse[]): Groups {
  const today: ConversationResponse[] = [];
  const yesterday: ConversationResponse[] = [];
  const older: ConversationResponse[] = [];
  const now = new Date();
  const yesterdayStr = new Date(now.getTime() - 86_400_000).toDateString();
  for (const c of items) {
    const d = new Date(c.updated_at).toDateString();
    if (d === now.toDateString()) today.push(c);
    else if (d === yesterdayStr) yesterday.push(c);
    else older.push(c);
  }
  return { today, yesterday, older };
}

export function Sidebar({
  items,
  selectedId,
  user,
  isMobile,
  collapsed,
  mobileOpen,
  onSelect,
  onNew,
  onRename,
  onRequestDelete,
  onLogout,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  const [renameId, setRenameId] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  useEffect(() => {
    const handler = () => setMenuFor(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const groups = useMemo(() => groupByDate(items), [items]);

  const sidebarClasses = ["sidebar"];
  if (collapsed) sidebarClasses.push("collapsed");
  if (mobileOpen) sidebarClasses.push("open");

  const renderRow = (c: ConversationResponse) => {
    const isRenaming = renameId === c.id;
    return (
      <div
        key={c.id}
        className={`history-row${selectedId === c.id ? " active" : ""}`}
        onClick={() => {
          if (isRenaming) return;
          onSelect(c.id);
          if (isMobile) onCloseMobile();
        }}
      >
        {isRenaming ? (
          <input
            autoFocus
            ref={(el) => el?.select()}
            defaultValue={c.title ?? ""}
            className="history-rename"
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              onRename(c.id, event.target.value);
              setRenameId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenameId(null);
            }}
          />
        ) : (
          // Title-pending skeleton is wired in step 10 (pendingTitleIds); this
          // step shows a "新对话" fallback for activated rows with no title.
          <span className="title">{c.title || "新对话"}</span>
        )}
        {!isRenaming && (
          <button
            className="menu-btn"
            aria-label="更多"
            onClick={(event) => {
              event.stopPropagation();
              setMenuFor(menuFor === c.id ? null : c.id);
            }}
          >
            <Icons.More size={14} />
          </button>
        )}
        {menuFor === c.id && (
          <div
            className="history-menu"
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "absolute",
              right: 6,
              top: "calc(100% - 4px)",
              background: "var(--bg-raised)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--menu-radius, 6px)",
              padding: 4,
              zIndex: 10,
              minWidth: 120,
              boxShadow: "0 6px 20px rgba(20,20,19,0.08)",
            }}
          >
            <button
              className="sheet-item"
              style={{ padding: "7px 10px", fontSize: 13 }}
              onClick={() => {
                setRenameId(c.id);
                setMenuFor(null);
              }}
            >
              <Icons.Pen size={13} />
              重命名
            </button>
            <button
              className="sheet-item destructive"
              style={{ padding: "7px 10px", fontSize: 13 }}
              onClick={() => {
                onRequestDelete(c.id);
                setMenuFor(null);
              }}
            >
              <Icons.Trash size={13} />
              删除对话
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <aside className={sidebarClasses.join(" ")}>
        <div className="sidebar-inner">
          <div className="brand">
            <Wordmark />
            {!isMobile && (
              <button className="icon-btn" aria-label="收起侧栏" onClick={onToggleCollapsed}>
                <Icons.PanelLeft size={15} />
              </button>
            )}
          </div>

          <button
            className="new-chat"
            onClick={() => {
              onNew();
              if (isMobile) onCloseMobile();
            }}
          >
            <Icons.Plus size={14} />
            新建对话
            {!isMobile && <span className="kbd">⌘ N</span>}
          </button>

          <div className="history">
            {groups.today.length > 0 && (
              <>
                <div className="history-section-label">今天</div>
                {groups.today.map(renderRow)}
              </>
            )}
            {groups.yesterday.length > 0 && (
              <>
                <div className="history-section-label">昨天</div>
                {groups.yesterday.map(renderRow)}
              </>
            )}
            {groups.older.length > 0 && (
              <>
                <div className="history-section-label">更早</div>
                {groups.older.map(renderRow)}
              </>
            )}
            {items.length === 0 && (
              <div
                style={{
                  padding: "16px 10px",
                  fontSize: 12.5,
                  color: "var(--fg-subtle)",
                  lineHeight: 1.6,
                }}
              >
                还没有已保存的对话。开始一次对话后会自动出现在这里。
              </div>
            )}
          </div>

          <div className="account">
            <div className="avatar">{(user?.name || "U").slice(0, 1).toUpperCase()}</div>
            <div className="account-name">{user?.email || "you@example.com"}</div>
            <button className="icon-btn" aria-label="退出登录" onClick={onLogout}>
              <Icons.LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>
      {isMobile && (
        <div
          className={`scrim${mobileOpen ? " show" : ""}`}
          onClick={onCloseMobile}
          aria-hidden={!mobileOpen}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/conversations/Sidebar.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/conversations/Sidebar.tsx frontend/src/conversations/Sidebar.test.tsx
git commit -m "feat(frontend): add sidebar with grouping rename and delete"
```

---

## Task 17: AppShell 装配 + 接入认证门

**Files:**
- Create: `frontend/src/app/AppShell.tsx`
- Test: `frontend/src/app/AppShell.test.tsx`
- Modify: `frontend/src/app/App.tsx`
- Modify: `frontend/src/app/App.test.tsx`
- Delete: `frontend/src/app/AuthedPlaceholder.tsx`

- [ ] **Step 1: 写失败测试（AppShell）**

创建 `frontend/src/app/AppShell.test.tsx`：

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationDetailResponse, conversationResponse } from "../test/apiFixtures";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads and lists conversations on mount", async () => {
    const services = createFakeServices(
      {},
      { list: async () => [conversationResponse] },
    );
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText(conversationResponse.title as string)).toBeInTheDocument();
  });

  it("loads detail when a conversation is selected", async () => {
    const services = createFakeServices(
      {},
      {
        list: async () => [conversationResponse],
        detail: async () => conversationDetailResponse,
      },
    );
    const user = userEvent.setup();
    renderWithApp(<AppShell />, services);

    await user.click(await screen.findByText(conversationResponse.title as string));

    // user message content from the detail fixture
    expect(await screen.findByText("Hello")).toBeInTheDocument();
  });

  it("shows the welcome heading in the empty state", async () => {
    const services = createFakeServices({}, { list: async () => [] });
    renderWithApp(<AppShell />, services);

    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --dir frontend exec vitest run src/app/AppShell.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 AppShell**

创建 `frontend/src/app/AppShell.tsx`：

```tsx
import { useEffect, useState } from "react";

import { Sidebar } from "../conversations/Sidebar";
import { Topbar } from "../conversations/Topbar";
import { selectionStore } from "../conversations/selectionStore";
import { useConversationLoader } from "../conversations/useConversationLoader";
import { MessageThread } from "../messages/MessageThread";
import { useAuthSession } from "../auth/useAuthSession";
import { Composer } from "../ui/Composer";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useAppActions, useAppState } from "./context";
import "../styles/chat.css";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 760,
  );
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 760);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

export function AppShell() {
  const { user, logout } = useAuthSession();
  const { ui } = useAppState();
  const { dispatch } = useAppActions();
  const {
    items,
    selectedId,
    detail,
    loadList,
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  } = useConversationLoader();

  const isMobile = useIsMobile();
  const [composerValue, setComposerValue] = useState("");

  // Bootstrap: load list, then restore stored selection (non-streaming).
  useEffect(() => {
    let active = true;
    void (async () => {
      await loadList();
      if (!active) return;
      const storedId = selectionStore.read();
      if (storedId != null) {
        await selectConversation(storedId);
      } else {
        newConversation();
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+N starts a new conversation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newConversation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newConversation]);

  const activeConversation = detail.conversation;
  const messages = detail.messages;
  const showWelcome = selectedId == null || messages.length === 0;
  const sidebarCollapsed = ui.sidebarCollapsed;

  const confirmTarget =
    ui.confirmDialog?.kind === "deleteConversation"
      ? ui.confirmDialog.conversationId
      : null;

  return (
    <div className="app">
      <Sidebar
        items={items}
        selectedId={selectedId}
        user={user ? { email: user.email, name: user.username } : null}
        isMobile={isMobile}
        collapsed={sidebarCollapsed && !isMobile}
        mobileOpen={ui.mobileSidebarOpen}
        onSelect={(id) => void selectConversation(id)}
        onNew={newConversation}
        onRename={(id, title) => void renameConversation(id, title)}
        onRequestDelete={(id) =>
          dispatch({
            type: "ui/openConfirm",
            dialog: { kind: "deleteConversation", conversationId: id },
          })
        }
        onLogout={() => void logout()}
        onToggleCollapsed={() => dispatch({ type: "ui/toggleSidebarCollapsed" })}
        onCloseMobile={() => dispatch({ type: "ui/setMobileSidebar", open: false })}
      />

      <main className="main">
        <Topbar
          title={activeConversation?.title ?? null}
          titlePending={false}
          isMobile={isMobile}
          sidebarCollapsed={sidebarCollapsed}
          onOpenMobile={() => dispatch({ type: "ui/setMobileSidebar", open: true })}
          onToggleSidebar={() => dispatch({ type: "ui/toggleSidebarCollapsed" })}
          onNewMobile={newConversation}
        />

        <div className="thread-region">
          {!showWelcome && <MessageThread messages={messages} />}
        </div>

        <div className="composer-area">
          <div className={`welcome-section${showWelcome ? "" : " hidden"}`}>
            <h1 className="welcome-heading">我们先从哪里开始呢？</h1>
          </div>
          <Composer value={composerValue} onChange={setComposerValue} />
        </div>
        <div className={`spacer-below${showWelcome ? " show" : ""}`} />
      </main>

      {confirmTarget != null && (
        <ConfirmDialog
          title="删除对话？"
          body="此对话及其全部消息将永久删除，无法恢复。"
          confirmLabel="删除"
          destructive
          onConfirm={() => void deleteConversation(confirmTarget)}
          onCancel={() => dispatch({ type: "ui/closeConfirm" })}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --dir frontend exec vitest run src/app/AppShell.test.tsx`
Expected: PASS。

- [ ] **Step 5: 接入认证门并删除占位**

修改 `frontend/src/app/App.tsx`，整体替换为：

```tsx
import { AuthScreen } from "../auth/AuthScreen";
import { useAuthSession } from "../auth/useAuthSession";
import { AppShell } from "./AppShell";

export function App() {
  const { bootstrapped, isAuthenticated } = useAuthSession();

  if (!bootstrapped) {
    return null;
  }

  return isAuthenticated ? <AppShell /> : <AuthScreen />;
}
```

删除文件 `frontend/src/app/AuthedPlaceholder.tsx`。

- [ ] **Step 6: 更新 App.test.tsx**

修改 `frontend/src/app/App.test.tsx`：把第二、三个用例对占位页的断言改为对 AppShell 的断言。整体替换为：

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

  it("shows the chat shell when a session is restored", async () => {
    tokenStore.save(createAuthSession(authTokenResponse));

    renderWithApp(<App />, createFakeServices());

    // The empty-state welcome heading appears in the chat shell.
    expect(await screen.findByText("我们先从哪里开始呢？")).toBeInTheDocument();
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

- [ ] **Step 7: 运行全量测试**

Run: `pnpm --dir frontend exec vitest run`
Expected: 全部通过（含新旧测试）。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx frontend/src/app/App.tsx frontend/src/app/App.test.tsx
git rm frontend/src/app/AuthedPlaceholder.tsx
git commit -m "feat(frontend): wire chat shell behind the auth gate"
```

---

## Task 18: 全量验证

**Files:** 无新增；门禁。

- [ ] **Step 1: Lint**

Run: `pnpm --dir frontend run lint`
Expected: 通过（如有 `react-hooks/exhaustive-deps` 警告，仅 AppShell bootstrap effect 处已 disable）。

- [ ] **Step 2: Typecheck**

Run: `pnpm --dir frontend run typecheck`
Expected: 通过。

- [ ] **Step 3: 测试**

Run: `pnpm --dir frontend exec vitest run`
Expected: 全部通过。

- [ ] **Step 4: Build**

Run: `pnpm --dir frontend run build`
Expected: 成功，产物输出到 `frontend/dist/`。

- [ ] **Step 5: 本地手动 smoke（可选）**

在两个终端：

```bash
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
pnpm --dir frontend dev
```

确认：登录后进入工作台；侧栏列出已激活会话并按日期分组；点击加载详情（Markdown + 思考）；新建进入欢迎态；重命名/删除（确认框）生效；刷新恢复上次选择；Composer 发送按钮禁用；退出回认证页。

> 需 `frontend/.env` 设 `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1`，后端 `CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`。

- [ ] **Step 6: Commit（若 smoke 有微调）**

```bash
git add -A
git commit -m "chore(frontend): conversation list and detail polish"
```

---

## 完成标准

- `pnpm run lint` / `run typecheck` / `exec vitest run` / `run build` 全绿。
- 登录后进入聊天工作台（取代 AuthedPlaceholder），视觉与 `chatapp_demo` 一致。
- 列表加载 + 分组 + 选择详情（只读 Markdown + 思考）+ 新建空白态 + 重命名 + 删除（确认框）+ 刷新恢复 + 403/404 静默清理 全部可用。
- Composer 发送禁用，不产生消息/run。
- 退出/身份失效清空列表、详情、选择持久化并回认证页。
- 后续步骤所需结构（pendingTitleIds、status pill、draftId、Composer 键盘处理）已就位。
