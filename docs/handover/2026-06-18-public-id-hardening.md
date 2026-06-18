# 实现纪录：public_id 标识符加固 + 前端深链路由（Phase 1）

日期：2026-06-18
分支：`feat/public-id-sharing`
设计依据：[`docs/superpowers/specs/2026-06-18-public-id-and-conversation-sharing-design.md`](../superpowers/specs/2026-06-18-public-id-and-conversation-sharing-design.md)

## 范围

原先 `conversations` / `messages` / `runs` 的自增 bigint 主键直接作为 `id` / `conversation_id` / `message_id` / `run_id` 暴露在 API 表面。本次把对外标识符全部换成不透明的 **UUID `public_id`**（双键方案：内部 PK/FK 仍是 bigint，不动），并在前端引入 **React Router**，让会话地址 `/c/:publicId` 可深链、可复制、刷新可恢复。

这是设计文档里的 **Phase 1**。Phase 2（会话分享 `share_links` + 公开只读页）尚未开始。

核心原则：
- **内部一律 bigint 不变**：主键、外键、`(conversation_id, position)` / `(run_id, seq)` 复合索引、worker claim/lease、`pg_notify` 载荷（`str(run.id)`）、SSE seq/`after_seq` 重放语义全部保持。
- **`public_id` 只在边界**：service 函数入口把 `public_id` 解析成内部 ORM 对象（拿到 bigint），之后既有逻辑零改动；响应序列化时再把内部引用映射回 `public_id`。
- **破坏性契约变更**：path 参数与响应字段类型从 number 变 UUID，不做新旧并存（单人控制双端，硬切换）。

## 关键文件

### 后端

- `alembic/versions/20260618_0006_add_public_id.py`：三表各加 `public_id uuid`（先 nullable → `UPDATE ... gen_random_uuid()` 回填 → `NOT NULL` + `server_default gen_random_uuid()` → 唯一约束 `uq_<table>_public_id`）。PostgreSQL 16 内置 `gen_random_uuid()`，无需扩展。`downgrade()` 反向，已验证可逆。
- `app/models/conversation.py`、`app/models/run.py`：`Conversation` / `Message` / `Run` 新增 `public_id: Mapped[uuid.UUID]`（`PGUUID(as_uuid=True)`，`unique=True`，`default=uuid.uuid4` + `server_default=text("gen_random_uuid()")`）。应用侧 `default` 让对象 flush 后即可读到 `public_id`（构造响应无需 refresh）；`server_default` 是裸 INSERT / 老镜像的兜底。
- `app/schemas/conversations.py`：`ConversationResponse.id` 改 `uuid.UUID` 并用 `Field(validation_alias="public_id")` + `populate_by_name=True`（`model_validate(conversation)` 直接读 `public_id`）；`MessageResponse.{id,conversation_id,run_id}`、`RunResponse.{id,conversation_id,user_message_id}` 改 `uuid.UUID`。
- `app/schemas/runs.py`：`RunStateResponse.run_id` 改 `uuid.UUID`。
- `app/services/conversations/service.py`：
  - `get_owned_visible_conversation[_for_update]` 改按 `public_id` 查；`_get_owned_unarchived_message_by_public_id`（新）按 `message_public_id` 查，**保留** `_get_owned_unarchived_message_for_update`（内部 int）供 regenerate 解析 `target_run.user_message_id`。
  - 三个 run 创建函数 + 详情/改名/删除函数入参改 `conversation_public_id` / `message_public_id`。
  - `message_response` / `run_response` 改为显式构造，需传入跨实体的 `public_id`；`conversation_response` 仍用 `model_validate`（靠 alias）。
  - `_run_public_id_map`（新）：`get_conversation_detail` 里**一次性**批量把消息引用的内部 `run_id` 映射成 `run.public_id`，避免 N+1。
- `app/services/runs/service.py`：`get_owned_visible_run` / `cancel_owned_run` / `get_owned_run_state` / `list_owned_run_events_after` 改按 `run_public_id`；内部的 `append_run_event` / `list_run_events_after` / `run_has_terminal_event` 仍用内部 `run_id`。`RunStateResponse.run_id=run.public_id`。
- `app/api/v1/conversations.py`、`app/api/v1/runs.py`：path 参数 `int → uuid.UUID`（非法 UUID 自动 422）。**SSE 路由**先 `get_owned_visible_run(run_public_id=...)` 解析出 `run.id`（内部），后续 `list_run_events_after` / `run_has_terminal_event` / `manager.subscribe/unsubscribe` 全用内部 id（与 `pg_notify` 载荷一致）。

### 前端

- `frontend/src/api/types.ts`：`ConversationResponse.id`、`MessageResponse.{id,conversation_id,run_id}`、`RunResponse.{id,conversation_id,user_message_id}`、`RunStateResponse.run_id` 由 `number` 改 `string`。**未改**：`AuthUserResponse.id`、`MessageSource.id` / `RunToolSource.id`（联网来源序号）、`seq` / `position` / `latest_seq` 等。
- `frontend/src/api/conversations.ts`、`runs.ts`：客户端方法签名 `number → string`。
- `frontend/src/conversations/selectionStore.ts`：存字符串；**更换 storage key** 为 `ichat.selectedConversationPublicId`，使旧的数字值自然失效（不会被当成非法 UUID 打到后端）。
- `frontend/src/conversations/state.ts`、`ui/state.ts`、`runs/state.ts`、`runs/pendingRun.ts` 及各 hook/组件（`useConversationLoader` / `useRegenerate` / `useSendMessage` / `useRunStream` / `useRunRecovery` / `useTitlePolling` / `Sidebar` / `Message` / `MessageThread`）：id 相关 `number → string`。生产代码这部分基本是「类型透传」，故改动集中在类型标注。
- **路由**（项目此前完全无路由）：
  - `frontend/src/main.tsx`：最外层包 `<BrowserRouter>`。
  - `frontend/src/app/AppShell.tsx`：用 `useLocation` 解析 `/c/:publicId`（**不用 `<Routes>`/`useParams`**，这样 `/` ↔ `/c/:id` 切换时 AppShell 不会被卸载重挂、bootstrap 不会重跑）+ `useNavigate`。`routerReady` 状态门控 URL↔state 同步。
    - 一次性 bootstrap：`loadList` + capabilities；落在 `/` 且 `selectionStore` 有值时 `navigate('/c/<stored>', {replace})` 恢复上次会话；否则 `setRouterReady(true)`。
    - **URL→state** effect `[publicId, routerReady]`：选中并 `recover`，或在 `/` 下 `newConversation`。
    - **state→URL** 镜像 effect `[selectedId, routerReady]`：把「发首条消息建会话 / 删除自动选中」等 state 变更回写地址栏。
  - `onSelectConversation` / `onNewConversation` 改为 `navigate(...)`，实际加载交给 URL→state effect。

## 设计要点回顾

- **为什么不把主键换成 UUID**：内部全是 bigint 连接与复合索引，换主键会让所有 FK/索引膨胀、写入局部性变差、改动面巨大。双键（保留 bigint + 新增 `public_id`）改动纯增量。
- **`public_id` 不是访问防线**：越权早已由各 service 的 `user_id` 过滤挡住（猜到他人 id 返回 404）。`public_id` 解决的是「顺序 id 泄露业务体量」的信息泄露，以及深链/未来分享的稳定寻址。因此用随机 UUIDv4（非 v7，避免泄露创建时间）即可。
- **`message.run_id` 必须是 run 的 `public_id`**：前端 `findPendingRunId` 用 `message.run_id === run.id` 判断是否需要恢复流，二者必须同一 id 空间；故 `get_conversation_detail` 批量映射。
- **regenerate 的两种消息查找**：入口 `target` 按 path 的 `message_public_id` 查；内部 `anchor` 由 `target_run.user_message_id`（内部 int）查——保留两个 helper，不混用。
- **对外字段名仍叫 `id`**：只改类型（number→UUID 字符串），不新增 `public_id` 字段名，减少契约与前端改动面，并彻底移除数字 id（不并存）。
- **前端用 `useLocation` 解析而非路由表**：保证 `/` ↔ `/c/:id` 间只有一个 AppShell 实例，避免重挂导致 bootstrap（拉列表）反复触发。

### 深链竞态（一个踩过的坑，务必保留修复）

URL→state 与 state→URL 两个 effect 在 `routerReady` 翻 true 的**同一次渲染**里都会跑。state→URL 镜像 effect 若读**渲染闭包**里的 `selectedId`（此刻还是 `null`，因为 `selectConversation` 的 re-render 还没提交），就会误判「URL 有 id 但没选中」→ `navigate('/')`，把深链冲掉，落到空白新对话。

修复：镜像 effect 读 **`stateRef.current.conversationIndex.selectedId`**（`AppProvider` 的 `dispatch` 同步推进 `stateRef`，而 URL→state effect 先执行并已同步 dispatch 了选中），二者相等 → 不误跳。回归测试见 `AppShell.test.tsx::loads the conversation named in the URL on a deep link`。

## 验证

```bash
# 迁移（本地宿主机跑需覆盖 DATABASE_URL 指向 localhost；docker 内不必）
DATABASE_URL="postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat" uv run alembic upgrade head
# 可逆性：alembic downgrade -1 && alembic upgrade head 已验证

# 后端（注意：本地测试与 docker worker 共用同一 ichat 库，跑前先 docker compose stop worker，
# 否则 worker 抢占测试 run 会导致 system_prompt_snapshot 等断言偶发失败；跑完 up -d --no-deps worker）
uv run pytest            # 242 passed
uv run ruff check app tests
uv run mypy app

# 前端（frontend/ 内）
pnpm exec vitest run     # 295 passed
pnpm run typecheck
pnpm run lint
pnpm run build
```

本次实测：后端 **242 passed**，ruff / mypy 干净；前端 **295 passed**，typecheck / lint / build 全绿。

新增/改写测试要点：
- `tests/models/test_metadata.py`：用 `test_public_id_columns_are_uuid_and_unique` / `test_uuid_columns_are_limited_to_public_ids` / `test_primary_keys_remain_bigint` 取代旧的「无 UUID 列」断言，固化「内部 bigint、仅三处 public_id 是 UUID」的不变量。
- `tests/api/test_conversations.py`、`test_runs.py`：seed helper 同时返回 public_id（URL/响应比对）与 db id（ORM `session.get`）；`session.get(Run, <uuid>)` 改 `select(Run).where(Run.public_id == uuid.UUID(...))`；鉴权/校验用例用合法 UUID 字面量。
- `tests/services/**`：service 调用改 `*_public_id`，跨 id 空间断言改为「响应 public_id ↔ public_id」「ORM 内部 id ↔ 内部 id」。
- 前端 `apiFixtures` / `appHarness`（`MemoryRouter` 包裹 + 可选 `initialEntries`）/ 各 `*.test.*`：实体 id 字面量 number→string；新增深链回归用例。

## 部署说明（重要）

- **必须重建镜像**：当前线上/本地运行的容器镜像早于本迁移。`docker compose start/up worker` 会触发 `migrate` 服务跑 `alembic upgrade head`，而旧镜像不认识 `20260618_0006`、且库已在该版本 → migrate 失败。本地恢复 worker 用 `docker compose up -d --no-deps worker`（worker 旧代码靠 `server_default` 对新 schema 兼容）。正式部署 push 到 `main` 后 deploy workflow 会用新镜像跑 migrate，正常。
- 这是**破坏性契约变更**：先部署后端（接受 UUID path），再部署前端；切换窗口内旧前端会失效（数字 id 打到期望 UUID 的后端 → 422/404）。
- 前端新增 `/c/*` 路由依赖 SPA history fallback——Cloudflare Pages 默认对 SPA 回 `index.html`，确认 `/c/<id>` 直接访问能命中 `index.html`；本地 Vite dev server 默认已支持。

## 已知局限 / 待办

- **Phase 2（会话分享）未做**：`share_links` 表、公开只读 `GET /api/v1/share/{token}`、管理接口、前端 `/share/{token}` 只读页与分享 UI 尚未实现，设计已在 spec 里定稿（快照、含 reasoning、可过期/多份/撤销）。
- 深链 404（他人/失效会话 id）目前停在空白态，URL 仍保留 `/c/<bad>`，未主动跳回 `/`——可接受，Phase 2 视情况再处理。
- `users` / `run_events` / `*_tokens` 未加 `public_id`（不按 id 对外寻址）。
- 端到端（真实 dev server + 浏览器）尚未跑 Playwright 验证，目前以单元/组件测试覆盖深链逻辑。
