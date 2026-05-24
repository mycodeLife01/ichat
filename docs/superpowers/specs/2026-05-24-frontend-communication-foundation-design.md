# 前端通信基础层设计

日期：2026-05-24

## 目标

本规格定义 React 前端重构的第 2 个实施任务：在 `frontend/src/` 中建立可测试、可复用、类型化的通信基础层，为后续认证页、会话状态、run 生命周期、SSE replay 和聊天 UI 迁移提供稳定边界。

该任务承接 `2026-05-24-frontend-react-rebuild-design.md` 的实施顺序。当前 React/Vite/TypeScript/pnpm 脚手架已经完成，但 `frontend/src/api/`、`auth/`、`conversations/`、`runs/` 等目录仍只有占位文件。本任务只建立前端与现有后端 API 的通信合同，不实现最终 UI、不建立 React 全局 reducer、不调整后端 CORS 或静态挂载。

## 已确认决策

| 决策点 | 选择 |
|--------|------|
| 任务范围 | typed API client、auth token/session helpers、401 refresh/retry、SSE parser/stream client、测试工具与 fixtures |
| 后端接口 | 直接对齐现有 FastAPI `/api/v1/*` 接口，不新增后端业务 API |
| 成功响应 | 所有 JSON 成功响应统一读取 `{"data": ...}` envelope |
| 错误模型 | 非 2xx 响应转换为前端 `ApiError`，保留机器可判定字段，用户可见文案单独映射 |
| 认证策略 | 继续使用 localStorage 保存 access/refresh token，本任务不迁移到 httpOnly cookie |
| refresh 行为 | 401 时只尝试一次 refresh + 原请求 retry，refresh 失败交给调用方执行统一私有状态清理 |
| SSE 方式 | 使用 `fetch` + `ReadableStream` + `Authorization` header，不使用原生 `EventSource` |
| React 依赖 | 通信层不依赖 React；后续 hooks 只消费本任务暴露的纯 TypeScript API |
| 测试策略 | Vitest 覆盖 parser、client、refresh/retry、abort 与 typed endpoint wrapper |

## 背景与现状

旧 vanilla 前端已经验证过真实后端行为，包括登录注册、refresh token 自动刷新、会话 CRUD、发送消息、run state、SSE `after_seq` replay、取消、失败 partial 内容保留、编辑并重新生成、重新生成回答。React 重构不能丢掉这些产品语义。

当前后端接口主要分布在：

- `app/api/v1/auth.py`
- `app/api/v1/conversations.py`
- `app/api/v1/runs.py`

现有响应 envelope 由 `app/schemas/responses.py` 定义：

```json
{
  "data": {}
}
```

SSE endpoint 返回格式由 `format_sse_event()` 定义：

```text
id: <seq>
event: <type>
data: <RunEventResponse JSON>
```

因此前端通信层可以先在单元测试中锁定接口合同，再让后续 UI 和状态层基于它开发。

## 范围

### 包含

- API base URL 读取与校验：`import.meta.env.VITE_API_BASE_URL`。
- 通用 JSON request 封装：method、body、query、headers、signal。
- 成功 envelope 解析：统一返回 `payload.data`。
- `ApiError`：包含 HTTP status、后端 `detail`、可选 error code、原始 payload、用户可见中文 message。
- auth token 存储 helper：读取、写入、清空、判断 access token 是否存在。
- access token 自动注入 `Authorization: Bearer <token>`。
- 401 refresh + retry：同一个请求最多 retry 一次。
- refresh 失败通知机制：返回明确错误或调用注入的 `onAuthExpired` callback。
- typed endpoint wrappers：
  - `authApi.register`
  - `authApi.login`
  - `authApi.refresh`
  - `authApi.logout`
  - `conversationApi.list`
  - `conversationApi.create`
  - `conversationApi.detail`
  - `conversationApi.rename`
  - `conversationApi.remove`
  - `conversationApi.sendMessage`
  - `conversationApi.editAndRegenerate`
  - `conversationApi.regenerate`
  - `runApi.state`
  - `runApi.cancel`
  - `runApi.streamEvents`
- SSE parser：解析 `id:`、`event:`、多行 `data:`、空行 dispatch。
- SSE stream client：通过 async iterator 或 callback 输出 typed run event。
- stream abort：支持 `AbortSignal`，调用方可以在退出登录、切换身份、组件卸载或 run 结束时中止。
- 测试 fixtures 与 stream helpers：便于后续 reducer/hooks 复用。

### 不包含

- 不实现 React Context、reducer 或 hooks。
- 不实现登录/注册 UI。
- 不实现聊天 shell、消息列表、composer、toast。
- 不改后端 CORS、FastAPI static mount、Nginx 或部署配置。
- 不做真实浏览器端到端 smoke。
- 不把 token 存储迁移到 cookie。
- 不引入 OpenAPI codegen。首期手写类型，保持接口清晰且改动可控。

## 方案比较

### 方案 A：手写轻量通信层

在 `frontend/src/api/` 手写 `request()`、错误模型、SSE parser 和 endpoint wrappers。类型以现有后端 schema 为准手工定义。

优点：

- 代码量小，适合当前接口规模。
- 与项目现有设计文档保持一致，不新增生成链路。
- 可以精确测试 refresh/retry 和 SSE 行为。
- 后续 UI 层能消费稳定、直观的函数。

缺点：

- 后端 schema 变更时需要人工同步类型。

结论：采用。

### 方案 B：引入 OpenAPI 生成 client

从 FastAPI OpenAPI schema 生成 TypeScript client。

优点：

- 类型同步更自动。
- 后续接口数量增加时扩展性较好。

缺点：

- 需要新增生成脚本、生成产物管理和 CI 检查。
- 对 SSE streaming、refresh/retry、错误文案映射仍需手写包装。
- 当前接口规模较小，收益不足以抵消复杂度。

结论：暂不采用。

### 方案 C：直接在 hooks 里写 fetch

等实现认证页、会话页和 run hooks 时，在各自 hooks 中直接调用 `fetch`。

优点：

- 初期文件更少。

缺点：

- refresh/retry、错误解析、envelope 读取和 Authorization 注入容易分散。
- SSE replay 与普通 JSON 请求的错误处理难统一。
- 后续测试会被 React hooks 绑定，难以单独验证通信合同。

结论：不采用。

## 模块设计

推荐文件结构：

```text
frontend/src/
├── api/
│   ├── client.ts
│   ├── errors.ts
│   ├── env.ts
│   ├── types.ts
│   ├── auth.ts
│   ├── conversations.ts
│   ├── runs.ts
│   ├── sse.ts
│   └── index.ts
├── auth/
│   └── tokenStore.ts
└── test/
    ├── apiFixtures.ts
    └── stream.ts
```

职责边界：

| 文件 | 职责 |
|------|------|
| `api/env.ts` | 读取并规范化 `VITE_API_BASE_URL`，去除末尾 `/`，缺失时抛出开发期错误 |
| `api/errors.ts` | 定义 `ApiError`、错误 payload 解析、中文错误映射 |
| `api/client.ts` | 通用 request、Authorization 注入、JSON body、envelope 解析、401 refresh/retry |
| `api/types.ts` | 后端 DTO 类型与前端通信层类型 |
| `api/auth.ts` | `/auth/register`、`/auth/login`、`/auth/refresh`、`/auth/logout` |
| `api/conversations.ts` | `/conversations` 与消息发送、编辑、重新生成 endpoints |
| `api/runs.ts` | `/runs/{id}/state`、`/runs/{id}/cancel`、`streamEvents()` |
| `api/sse.ts` | 纯 SSE 文本 parser 与 ReadableStream 解码 |
| `auth/tokenStore.ts` | localStorage session 读写和清理，不依赖 React |
| `test/apiFixtures.ts` | 认证、会话、run response fixtures |
| `test/stream.ts` | 构造可控 `ReadableStream<Uint8Array>` 的测试 helper |

`api/client.ts` 可以依赖 `auth/tokenStore.ts`，但 `auth/tokenStore.ts` 不依赖 API client。这样 refresh/retry 的方向清晰，后续 React auth hooks 也可以单独调用 token store。

## 类型设计

首期类型应覆盖后续 UI 所需字段，不追求重建全部后端 ORM 细节。

核心类型包括：

```ts
type SuccessEnvelope<T> = {
  data: T;
  meta?: Record<string, unknown> | null;
};

type AuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUserResponse;
};

type AuthUserResponse = {
  id: number;
  username: string;
  email: string;
  email_verified: boolean;
};

type ConversationResponse = {
  id: number;
  title: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
};

type ConversationDetailResponse = ConversationResponse & {
  messages: MessageResponse[];
};

type MessageResponse = {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  position: number;
  run_id: number | null;
  created_at: string;
};

type RunStatus =
  | "queued"
  | "started"
  | "streaming"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

type RunResponse = {
  id: number;
  conversation_id: number;
  user_message_id: number;
  status: RunStatus;
  provider_name: string;
  provider_model: string;
  created_at: string;
};

type SendMessageResponse = {
  message: MessageResponse;
  run: RunResponse;
};

type RunStateResponse = {
  run_id: number;
  status: RunStatus;
  latest_seq: number;
  draft_text: string;
  draft_reasoning: string;
  terminal_event: RunEventResponse | null;
};

type RunEventType =
  | "run_started"
  | "text_delta"
  | "reasoning_delta"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled";

type RunEventResponse = {
  seq: number;
  type: RunEventType;
  payload: Record<string, unknown>;
  created_at: string;
};
```

以上字段来自当前 `app/schemas/auth.py`、`app/schemas/conversations.py` 与 `app/schemas/runs.py`。实现时如发现后端 schema 已变更，应以后端 schema 为权威，并在后续交接中记录差异。

## 请求行为

### 普通 JSON 请求

1. 调用 endpoint wrapper。
2. wrapper 调用 `apiRequest<T>()`。
3. `apiRequest` 组装 URL、headers、body 与 `AbortSignal`。
4. 若 token store 中存在 access token，注入 `Authorization`。
5. 发送 `fetch`。
6. 若响应为 2xx，解析 JSON envelope 并返回 `data`。
7. 若响应为 401 且本次请求允许 refresh 且尚未 retry，调用 refresh flow。
8. refresh 成功后写入新 token，并重试原请求。
9. refresh 失败时清空 token store，调用 `onAuthExpired`，抛出 `ApiError`。
10. 其他非 2xx 响应解析为 `ApiError`。

### refresh 请求

refresh 请求自身必须禁用自动 refresh，避免递归。

当多个请求同时收到 401 时，首期可采用简单策略：每个请求独立触发 refresh，但同一请求最多 retry 一次。若实现成本很低，可以增加单例 `refreshPromise` 合并并发 refresh；该优化不改变对外 API。

推荐采用合并并发 refresh，因为它可以避免 token 轮换时多个 refresh token 请求互相影响。

### logout 请求

`authApi.logout(refreshToken)` 成功或失败后，调用方都应可以清空本地 token。通信层只负责发请求和返回结果，不直接决定 UI 状态。

## 错误处理

`ApiError` 应至少包含：

- `status: number`
- `message: string`：中文用户可见文案
- `detail?: unknown`：后端原始 detail
- `payload?: unknown`：完整错误响应
- `isAuthExpired?: boolean`

错误文案映射规则：

- 401：`登录状态已失效，请重新登录`
- 403：`没有权限访问该资源`
- 404：`资源不存在或已被删除`
- 409：`当前操作与现有状态冲突，请稍后重试`
- 422：`提交内容不符合要求，请检查后重试`
- 5xx：`服务暂时不可用，请稍后重试`
- 网络错误：`网络连接失败，请检查后重试`
- AbortError：不转成 toast 文案，保留为可识别的取消状态

后续 UI 可以根据 `ApiError` 展示 toast、字段错误或静默清理状态。

## SSE 设计

### Parser

`parseSseChunk` 或等价 parser 应支持：

- `id: 12`
- `event: text_delta`
- `data: {...}`
- 多行 `data:` 拼接为 `\n`
- 空行表示一个 event 结束
- 忽略以 `:` 开头的 comment 行
- 忽略未知字段
- chunk 边界可以出现在任意字符之间

输出类型：

```ts
type ParsedSseEvent = {
  id?: string;
  event?: string;
  data: string;
};
```

再由 run stream client 将其转换为：

```ts
type RunStreamEvent = {
  seq: number;
  type: RunEventType;
  data: RunEventResponse;
};
```

### Stream client

`runApi.streamEvents(runId, afterSeq, options)` 应：

- 请求 `GET /runs/{runId}/events?after_seq=<afterSeq>`。
- 注入 access token。
- 使用 `Accept: text/event-stream`。
- 逐个 yield 或 callback typed event。
- 遇到 `run_succeeded`、`run_failed`、`run_cancelled` 后自然结束。
- 支持调用方通过 `AbortSignal` 中止。
- 对非 2xx SSE 响应复用 `ApiError` 解析。

推荐对外提供 async iterator：

```ts
for await (const event of runApi.streamEvents(runId, afterSeq, { signal })) {
  // reducer/hook handles event
}
```

如果后续 hooks 更适合 callback，可以在 hooks 层包装，不需要改变 parser。

## 测试策略

### 必测单元

API client：

- 2xx envelope 返回 `data`。
- 缺失 `data` 时抛出结构错误。
- 非 2xx JSON 错误转换为 `ApiError`。
- 网络错误转换为网络类 `ApiError`。
- 401 时调用 refresh 并 retry 原请求。
- refresh 成功后 token store 写入新 token。
- refresh 失败后 token store 清空，`onAuthExpired` 被调用。
- refresh 请求本身不会递归 refresh。
- `AbortError` 保持可识别，不误报为普通网络错误。

Endpoint wrappers：

- 每个 wrapper 使用正确 method、path、body。
- `sendMessage`、`editAndRegenerate`、`regenerate` 对齐当前后端路径。
- `runApi.cancel` 使用 POST。
- `runApi.state` 使用 GET。

SSE parser：

- 单个完整事件解析成功。
- 多个事件在同一 chunk 中解析成功。
- 一个事件拆成多个 chunk 后解析成功。
- 多行 `data:` 正确拼接。
- comment 与未知字段被忽略。
- terminal event 可被识别。

Stream client：

- 能从 `ReadableStream` 按序产出 typed run events。
- `after_seq` 被正确写入 query。
- 非 2xx stream 响应抛出 `ApiError`。
- `AbortSignal` 中止后停止读取。

### 验证命令

本任务完成后至少运行：

```bash
cd frontend
pnpm run test -- --run
pnpm run typecheck
pnpm run lint
pnpm run build
```

若实现时调整共享测试 setup，还应确认现有 `src/app/App.test.tsx` smoke test 仍通过。

## 数据流示例

### 登录

```text
AuthScreen/hooks
  -> authApi.login({ identifier, password })
  -> apiRequest<AuthTokenResponse>()
  -> POST /auth/login
  -> read envelope.data
  -> tokenStore.save(session)
  -> caller updates React auth state
```

### 普通 API 自动 refresh

```text
conversationApi.list()
  -> GET /conversations with old access token
  -> 401
  -> authApi.refresh(refreshToken) without recursive refresh
  -> tokenStore.save(newSession)
  -> retry GET /conversations with new access token
  -> return ConversationResponse[]
```

### SSE replay

```text
runApi.streamEvents(runId, afterSeq)
  -> GET /runs/{runId}/events?after_seq=<afterSeq>
  -> decode ReadableStream chunks
  -> parse SSE frames
  -> JSON parse RunEventResponse
  -> yield typed events
  -> stop on terminal event or abort signal
```

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 前端类型与后端 Pydantic schema 不一致 | 实现前读取 `app/schemas/*.py`，类型字段以后端为准；测试 fixtures 使用真实字段名 |
| refresh 并发导致 token 轮换冲突 | 使用共享 `refreshPromise` 合并同一时间的 refresh |
| SSE chunk 边界导致 parser 漏事件 | parser 持有 buffer，测试覆盖任意拆分 chunk |
| AbortError 被当成普通错误弹 toast | 保留 abort 标识，UI 层默认静默处理 |
| 通信层过早绑定 React 状态 | 通信层只暴露纯函数、类型和 callback，不 import React |
| 错误中文文案过早耦合具体 UI | `ApiError.message` 提供默认中文文案，UI 仍可按场景覆盖 |

## 验收标准

- `frontend/src/api/` 有清晰的 typed API client、endpoint wrappers 和 SSE parser/stream client。
- `frontend/src/auth/tokenStore.ts` 或等价模块能读写清理本地 auth session。
- 所有 JSON 成功响应都通过 envelope 读取 `data`。
- 401 refresh + retry 行为有单元测试覆盖。
- refresh 失败会清理 token，并给后续 React auth 层明确的过期信号。
- SSE parser 能处理真实后端 `id/event/data` 格式和 chunk 拆分。
- `runApi.streamEvents` 使用 fetch 和 Authorization header，不依赖 `EventSource`。
- 通信层不依赖 React。
- `pnpm run test -- --run`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build` 通过。
- 该任务不修改后端行为、不实现 UI、不引入新的包管理器或 lockfile。

## 后续衔接

本任务完成后，下一步应进入 React 状态 reducer 与核心 hooks：

- `useAuthSession` 消费 `authApi` 与 `tokenStore`。
- `useConversationLoader` 消费 `conversationApi`。
- `useRunStream` 消费 `runApi.streamEvents`。
- reducer 处理 send message、reasoning/text delta、terminal event、cancel requested、标题 pending 和草稿清理。

后端 CORS 与静态挂载解耦可以在通信层完成后并行或紧接着执行，因为届时本地跨域 smoke 已经有真实前端请求基础。

## 关联文档

- 父级 React 重构设计：[`2026-05-24-frontend-react-rebuild-design.md`](2026-05-24-frontend-react-rebuild-design.md)
- React 脚手架交接：[`../../handover/frontend/2026-05-24-react-scaffold-and-pnpm.md`](../../handover/frontend/2026-05-24-react-scaffold-and-pnpm.md)
- 测试前端交接：[`../../handover/2026-05-17-test-frontend.md`](../../handover/2026-05-17-test-frontend.md)
- Run events / SSE replay：[`../../handover/2026-05-17-run-events-sse-replay.md`](../../handover/2026-05-17-run-events-sse-replay.md)
- Regenerate 实现记录：[`../../handover/2026-05-19-regenerate.md`](../../handover/2026-05-19-regenerate.md)
- DeepSeek 思考过程：[`2026-05-21-deepseek-thinking-design.md`](2026-05-21-deepseek-thinking-design.md)
