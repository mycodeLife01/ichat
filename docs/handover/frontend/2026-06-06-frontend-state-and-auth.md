# 2026-06-06 前端状态层与认证页交接文档

## 本次完成

按 `docs/superpowers/plans/2026-05-24-frontend-state-and-auth.md` 完整实现：在已有通信基础层（`src/api/*`、`src/auth/tokenStore.ts`）之上，建立 React 状态 reducer 架构与核心 hooks，并在其上做出接入真实认证 API 的登录/注册页与认证门。

本次只做**状态容器 + 认证**。`conversation/run/composer/ui` 四个切片只锁类型、只处理全局 RESET；`useConversationLoader`/`useRunStream` 仅保留签名占位（抛未实现），会话与运行的真实逻辑留给后续步骤。登录后目前仅渲染一个临时占位页。

实施采用 TDD：每个任务先写失败测试（RED），再实现最小通过代码（GREEN），随后提交，共 10 个任务、9 个功能提交（`b09c946`..`1756b83`）。前端测试从 42 增至 **61 全绿**。

## 主要改动

- 新增状态树切片：
  - `src/auth/state.ts`：`AuthState`、`AuthAction`、`authReducer`（做实）。
  - `src/conversations/state.ts`：`ConversationIndexState`/`ConversationDetailState` 类型 + 初始值 + 仅处理 RESET 的占位 reducer。
  - `src/runs/state.ts`：`ActiveRunState` 类型 + 占位 reducer（**AbortController 刻意不进 reducer**）。
- 新增组合根 reducer：`src/app/store.ts`，`AppState`/`AppAction`/`initialState`、内联 `composer`/`ui` reducer、`rootReducer`。
- 新增核心 hook 占位：`src/conversations/useConversationLoader.ts`、`src/runs/useRunStream.ts`（抛未实现，后续替换）。
- 新增 Context 层：`src/app/context.ts`，State / Actions 双 Context、`useAppState`/`useAppActions`、`Services`/`AuthApi`/`StreamAbortController`/`AppActions` 类型。
- 新增身份失效处理器：`src/app/authExpiry.ts`，`createAuthExpiryHandler`（abort 进行中 stream → dispatch `app/reset`）。
- 新增 Provider：`src/app/AppProvider.tsx`，`useReducer` 持状态 + 单例 `ApiClient`（装配 `onAuthExpired`）+ 两个 Context + 启动恢复 session。
- 新增认证编排 hook：`src/auth/useAuthSession.ts`，login/register/logout/提交态/身份编排，best-effort logout。
- 新增错误映射：`src/auth/authErrorMessages.ts`，`mapAuthError`（401/409 用户名/409 邮箱/422/abort/兜底 中文映射）。
- 新增认证页：`src/auth/AuthScreen.tsx` + `AuthScreen.css`，单卡片、登录/注册切换、字段校验、提交态、回车提交、字段级 + 表单级中文错误。
- 新增认证门与入口装配：`src/app/App.tsx`（改写为认证门）、`src/app/AuthedPlaceholder.tsx`（临时已登录占位）、`src/main.tsx`（用 `<AppProvider>` 包裹）。
- 新增测试 harness：`src/test/appHarness.tsx`，fake services + `renderWithApp`/`makeWrapper`。
- 每个业务源文件均带同名测试（占位 hook 除外，spec 明确不写测试）。

## 关键文件

- `frontend/src/app/store.ts`：单根 `rootReducer` 组合六切片；`app/reset` 清空所有切片但 `auth.bootstrapped` 保持 `true`。
- `frontend/src/app/context.ts`：State 与 Actions 拆成两个 Context，避免 dispatch/services 变化触发纯读组件重渲染。`StreamAbortController` 让后续 `useRunStream` 注册 abort，logout/身份失效可在不感知 stream 的前提下中止它。
- `frontend/src/app/AppProvider.tsx`：装配处。单例 `ApiClient` 的 `onAuthExpired` 接 `createAuthExpiryHandler`；启动用 `useEffect` 派发 `auth/restored`（读 tokenStore）。
- `frontend/src/auth/useAuthSession.ts`：唯一对 UI 暴露的认证编排入口，返回 `session/user/isAuthenticated/isSubmitting/bootstrapped` + `login/register/logout`。
- `frontend/src/auth/AuthScreen.tsx`：表单与中文校验、提交态、`mapAuthError` 展示映射。
- `frontend/src/auth/authErrorMessages.ts`：返回视图对象 `{ fieldErrors?, formMessage? }`，由 `AuthScreen` 消费。

## 设计决策

### 状态容器形态（方案 A）

- `useReducer` 持有整棵 `AppState`，State 与 Dispatch 拆两个 Context。`useReducer` 返回的 `dispatch` 生命周期内稳定，直接闭包捕获，无需 ref 转发（与 spec 伪代码的 ref 写法不同，效果一致且更简单）。
- 唯一需要 ref 的是「进行中 stream 的 abort」，因为它由后续 `useRunStream` 通过 `streamAbort.register` 注册。

### token 事实源与渲染镜像

- `tokenStore`（localStorage）是 token 的事实源；reducer 里的 `auth.session` 是渲染镜像。
- login/register/logout/启动恢复都同时写 tokenStore 和 dispatch，保持两者一致。

### 全局 RESET 与身份失效

- `app/reset` 清空 conversation/run/composer/ui 与 auth.session/status，但保留 `bootstrapped: true`（已恢复过就不再回到加载态）。
- `ApiClient.onAuthExpired`（refresh 失败时触发）→ `createAuthExpiryHandler` → 先 abort 进行中 stream，再 dispatch `app/reset`，统一清空私有状态。
- logout 为 best-effort：先尝试调用 logout API，失败也忽略，随后本地 abort + clear + reset。

### hook 与 UI 解耦（与 spec 的偏差）

- spec 伪代码让 hook `throw mapAuthError(...)`，但 `mapAuthError` 返回的是视图对象、不是 `Error`。本实现让 `useAuthSession` **重新抛出原始错误**，由 `AuthScreen` 调 `mapAuthError` 做展示映射，保持编排层与 UI 解耦。

### 循环依赖处理

- `store.ts` 用值导入各 slice reducer；slice 文件用 `import type { AppAction } from "../app/store"`（类型导入会被擦除）。运行时依赖只有 `store → slice` 单向，无运行时环。

## 计划外必要改动（2 处）

均为让计划自身的测试/类型检查可通过的最小补充，已随对应任务一并提交（Task 5，commit `7df8a97`）。

### 1. `src/test/setup.ts` 注册 RTL cleanup

项目未开 `test.globals`，`@testing-library/react` 的自动 `afterEach(cleanup)` 不会注册，导致同一测试文件内多次 `render` 的 DOM 跨用例累积，出现「Found multiple elements」冲突（Task 5/8/9 的测试触发）。补充标准的非 globals 写法：

```ts
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
```

### 2. `src/test/appHarness.tsx` 标注 `renderWithApp` 返回类型

`render(...)` 的推断返回类型在 `tsc -b` 下触发 TS2742（inferred type 无法可移植命名）。显式标注 `: RenderResult` 即可。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 61 个测试全部通过（16 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过，产物输出到 frontend/dist/
```

测试矩阵：rootReducer（auth slice + 全局 reset）、Context 读取 hook（Provider 内外）、authExpiry 顺序、AppProvider 启动恢复（空/有持久化 session）、useAuthSession（登录/失败重抛/注册/退出）、mapAuthError（401/409×2/422/abort/兜底）、AuthScreen（切换/空表单校验/邮箱校验/trim 提交/401 表单错/409 字段错/切换清错）、App 认证门（未登录→认证页 / 恢复 session→占位 / 退出→回认证页）。

未做计划的「Step 5 本地跨域 smoke」（需同时起前后端，手动验证），属可选。

## 当前边界

已完成：

- React 状态 reducer 架构、双 Context、AppProvider 装配、启动恢复。
- 认证全链路：注册 / 登录 / 刷新保持登录 / 退出，含中文校验与错误映射。
- `onAuthExpired` 已连到全局 reset + abort（abort 目标待 `useRunStream` 注册后才有实际效果）。

未完成，留给后续任务：

- **会话列表与详情**：实做 `conversationIndex/Detail` 的 feature actions + `useConversationLoader`，接 `api/conversations`（列表、草稿会话、加载消息、403/forbidden 处理、标题 pending）。
- **运行流式（SSE）**：实做 `activeRun` 的 feature actions + `useRunStream`，接 `api/sse` 与 `streamAbort.register`，处理 `after_seq` 重放、delta 拼接、取消、终态。
- **Composer + 聊天外壳 UI**：替换 `AuthedPlaceholder` 为侧栏 + 消息区 + 输入框，串起发送消息 → 创建 Run → 流式渲染；以及编辑重新生成、停止生成等业务迁移。
- CI workflow 实际改造（前端构建/测试纳入流水线）。

## 注意事项

- 登录后目前只有 `AuthedPlaceholder`（"聊天界面将在后续步骤接入"），即用户可登录但还不能聊天。
- 占位 hook `useConversationLoader`/`useRunStream` 当前调用会抛错，是刻意的签名占位，接入聊天前必须替换为真实实现。
- `streamAbort.abort()` 在没有任何 stream 注册时是 no-op（默认 `() => {}`）；logout/身份失效已调用它，待 `useRunStream` 注册后自然生效。
- 测试中始终通过 `createFakeServices` 注入 fake `authApi`，不触达真实 HTTP；`renderWithApp`/`makeWrapper` 已封装 `AppProvider` 的 services 注入。
- 运行/构建需注入 `VITE_API_BASE_URL`，且后端 `CORS_ALLOWED_ORIGINS` 需含前端 dev 源（`http://localhost:5173`）。

## 关联文档

- 本次对应计划：`docs/superpowers/plans/2026-05-24-frontend-state-and-auth.md`
- 对应 spec：`docs/superpowers/specs/2026-05-24-frontend-state-reducer-and-auth-design.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
- 前序通信层交接：`docs/handover/frontend/2026-05-24-frontend-communication-foundation.md`
