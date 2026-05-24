# 2026-05-24 前端通信基础层交接文档

## 本次完成

按 `docs/superpowers/plans/2026-05-24-frontend-communication-foundation.md` 完成第 2 步：在 `frontend/src/api/` 与 `frontend/src/auth/` 下建立纯 TypeScript 的通信基础层，覆盖 JSON API 调用、auth token 存储、401 refresh/retry、端点封装与 fetch-based SSE 流式解析，并全部用测试覆盖。

本次只建立通信与认证存储层，不涉及 React Context、reducer、hooks、UI 组件，也不改动后端。该层与 React 完全解耦，后续状态层和 UI 在其之上消费。

实施采用 TDD：每个任务先写失败测试（RED），再实现最小通过代码（GREEN），随后提交，共 9 个任务、8 个功能提交。

## 主要改动

- 新增 DTO 类型与测试 fixtures：`src/api/types.ts`、`src/test/apiFixtures.ts`。类型逐字段对齐后端 Pydantic schema。
- 新增 API base URL 规范化：`src/api/env.ts`，从 `import.meta.env.VITE_API_BASE_URL` 读取并去除尾部斜杠，空值抛错。
- 新增错误原语：`src/api/errors.ts`，`ApiError` 类、HTTP 状态码到中文文案映射、abort 识别、`toApiError`/`getErrorDetail`。
- 新增 auth 会话存储：`src/auth/tokenStore.ts`，localStorage 持久化，损坏 JSON 自动清理。
- 新增 JSON API client：`src/api/client.ts`，统一 envelope 解析、auth header 注入、查询参数构造、401 单次 refresh/retry、`fetchRaw` 暴露原始响应供 SSE 使用。
- 新增端点封装：`src/api/auth.ts`、`src/api/conversations.ts`、`src/api/runs.ts`。
- 新增 SSE 解析：`src/api/sse.ts`（`SseParser` 帧解析 + `decodeSseStream` 流解码）与测试助手 `src/test/stream.ts`。
- 新增公共导出：`src/api/index.ts`。
- 新增 Vite 环境类型声明：`src/vite-env.d.ts`（计划外必要补充，见下）。
- 移除占位文件：`src/api/.gitkeep`、`src/auth/.gitkeep`。
- 每个源文件均带同名 `*.test.ts`。

## 关键文件

- `frontend/src/api/types.ts`：所有后端响应 DTO 与 `SuccessEnvelope<T>`、`RunStreamEvent`。
- `frontend/src/api/client.ts`：`ApiClient` 核心，构造参数支持注入 `fetchImpl`、`tokenStore`、`onAuthExpired`，便于测试与身份失效回调。
- `frontend/src/api/errors.ts`：`ApiError` 与中文错误映射，用户可见错误不直接暴露后端英文 detail。
- `frontend/src/auth/tokenStore.ts`：`AuthSession` 结构与 `createAuthSession`（按 `expires_in` 计算 `expiresAt`）。
- `frontend/src/api/sse.ts`：跨 chunk 边界的 SSE 帧缓冲解析，兼容 `\n\n` 与 `\r\n\r\n`、多行 data、注释行。
- `frontend/src/api/runs.ts`：`streamEvents` 为 async generator，用 `fetchRaw` + `Accept: text/event-stream`，遇终止事件停止。
- `frontend/src/api/index.ts`：通信层唯一对外入口。
- `frontend/src/vite-env.d.ts`：`import.meta.env` 类型声明。

## 设计决策

### 统一 envelope 与错误

- 所有 JSON 成功响应统一走 `SuccessEnvelope<T>` 取 `payload.data`；缺失 `data` 字段视为响应格式异常并抛 `ApiError`。
- 非 2xx 转换为 `ApiError`，携带 status、后端 detail、原始 payload，但用户可见 message 用前端中文映射。

### 401 refresh/retry

- 仅在 `auth !== false` 且 `retryOnUnauthorized !== false` 时，对 401 触发一次 refresh，并用 `hasRetried` 标志保证只重试一次。
- refresh 请求自身使用 `auth: false` + `retryOnUnauthorized: false`，避免递归。
- 并发请求用 `refreshPromise` 去重，只发一次 refresh。
- refresh 失败时清空 `tokenStore` 并调用 `onAuthExpired`，抛出 `isAuthExpired: true` 的 `ApiError`，供上层统一 reset 私有状态。

### SSE 流式

- 继续使用 `fetch` + `ReadableStream`，不改用原生 `EventSource`（需要 `Authorization` header 且跨域）。
- `streamEvents` 解析每帧 `data` 为 `RunEventResponse`，遇 `run_succeeded`/`run_failed`/`run_cancelled` 主动 `return` 结束生成器。

### 端点路径

端点封装路径已逐一比对后端 `app/api/v1/{auth,conversations,runs}.py` 的实际路由，完全一致（`/auth/*`、`/conversations`、`/conversations/{id}/messages/{message_id}/edit-and-regenerate` 等）。base URL 含 `/api/v1` 前缀。

## 计划外必要改动：vite-env.d.ts

脚手架阶段未生成 Vite 客户端类型声明，导致 `import.meta.env.VITE_API_BASE_URL` 无法通过 `tsc`（`Property 'env' does not exist on type 'ImportMeta'`）。本次新增标准的 `frontend/src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

这是 Vite 工程惯例文件，属于让计划可运行的最小补充，随通信层一并提交。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 30 个测试全部通过（9 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过，产物输出到 frontend/dist/
```

测试覆盖：envelope 解析、错误映射与 abort、401 refresh/retry 与失败清理、token 存储与损坏 JSON、auth/conversation/run 端点封装路径、SSE 跨 chunk 解析与终止事件停止。

## 当前边界

已完成：

- 与 React 解耦的通信层（`src/api/`、`src/auth/`），经 grep 确认零 React 依赖。
- typed API client、auth session 存储、refresh/retry、SSE parser/stream client 全部就绪并测试覆盖。

未完成，留给后续任务：

- 后端移除静态挂载与新增 CORS（属于后端改动，本次未触碰）。
- React reducer、核心 hooks（`useAuthSession`、`useConversationLoader`、`useRunStream` 等）。
- 真实认证页与聊天 UI、会话/run/SSE replay/停止生成/标题 pending/编辑重新生成等业务迁移。
- CI workflow 实际改造。

## 注意事项

- `uiux_v1.html` 仍是仓库根目录未跟踪文件，本次未修改。
- 端点封装与 reducer 集成时，`onAuthExpired` 应连到全局状态 reset 并 abort 进行中的 SSE stream。
- 默认 `ApiClient`（`getDefaultApiClient`）从环境变量读取 base URL，运行时需注入 `VITE_API_BASE_URL`；测试中始终显式传 `baseUrl` 与 `fetchImpl`，不依赖环境。
