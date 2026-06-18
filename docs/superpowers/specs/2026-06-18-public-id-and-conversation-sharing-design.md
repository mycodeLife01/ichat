# public_id 标识符加固 + 会话分享 设计

日期：2026-06-18
分支：`feat/public-id-sharing`

## 背景与目标

当前后端把数据库自增主键（`conversations.id`、`messages.id`、`runs.id`）直接作为 `id` / `conversation_id` / `message_id` / `run_id` 暴露在 API 表面。两个诉求：

1. **标识符加固**：不在对外接口上暴露顺序自增 ID，避免泄露业务体量/增长速度等信息（枚举与 BI 推断）。
2. **会话分享**：近期要做"把一段会话分享出去给他人查看"，需要可复制的链接和稳定的会话寻址方式。

本设计同时覆盖这两件事，但**刻意把它们拆成两个独立机制**（见下）。

## 现状（关键事实，决定了设计方向）

- 所有主键均为 `BigInteger` 自增（`app/models/*.py`）。
- **对象级鉴权已正确实现**：每条读写路径都经过 `get_owned_visible_conversation` / `get_owned_visible_run`，强制 `Conversation.user_id == current_user.id` 过滤；猜到他人 ID 返回 404。**当前不存在越权漏洞，安全性不依赖 ID 保密。**
- 自增 ID 出现在 URL path 的接口：
  - `/api/v1/conversations/{conversation_id}`（GET/PATCH/DELETE）
  - `/api/v1/conversations/{conversation_id}/messages`（POST）
  - `/api/v1/conversations/{conversation_id}/messages/{message_id}/edit-and-regenerate`（POST）
  - `/api/v1/conversations/{conversation_id}/messages/{message_id}/regenerate`（POST）
  - `/api/v1/runs/{run_id}/state`、`/cancel`、`/events`
- 响应体暴露的 ID 字段：`ConversationResponse.id`、`MessageResponse.{id,conversation_id,run_id}`、`RunResponse.{id,conversation_id,user_message_id}`、`RunStateResponse.run_id`。
- Worker / 内部管道使用内部 `run.id` 作为 `pg_notify` 载荷（`runs_queued`、`run_events` 频道），以及 `(conversation_id, position)`、`(run_id, seq)` 等复合索引。**这些是内部机制，不在加固范围内。**
- 前端目前**没有任何 URL 路由**（无 router / `window.location` / `pushState`），会话选择是纯内存状态 + `localStorage`（`selectionStore`，键 `ichat.selectedConversationId`，存数字 ID）。"复制 URL 跳转"能力现在不存在，需要新增路由。
- PostgreSQL 16（`gen_random_uuid()` 内置，回填无需扩展）。

## 核心设计决策

### 决策 1：保留自增主键，新增 `public_id`（双键），不改主键

内部关系全部是 bigint 连接与复合索引。把主键换成 UUID 会让所有 FK/索引膨胀、写入局部性变差、改动面巨大、收益为负。
因此：**内部 PK / FK / worker / notify / seq 一律保持 bigint 不动**；只在对外可寻址的实体上**新增**一个带唯一索引的不透明 `public_id`，作为唯一的对外标识符。`public_id` 在服务层入口被解析回内部 bigint，之后所有既有逻辑不变。

### 决策 2：`public_id` 与"分享令牌"是两个不同的东西，必须分离

这是最关键的一点，避免常见错误：

| | `public_id` | 分享令牌 `share token` |
|---|---|---|
| 作用 | 在**已登录所有者**的接口/URL 上标识会话 | 让**任何持链人（可匿名）**只读访问某次会话快照 |
| 鉴权 | 仍受 `user_id` 所有权校验 | 故意绕过所有权校验，作用域严格限定为只读快照 |
| 可否撤销/多份/过期 | 否（会话身份，稳定不变） | 是（独立凭证，可撤销、可多份、可过期） |
| 位置 | `/c/{conversation_public_id}` | `/share/{token}` |
| 熵 | 标识符（UUIDv4，122 bit 足够，且非唯一防线） | bearer 秘密（`secrets.token_urlsafe(32)`，~256 bit） |

`public_id` 本身**不是**分享机制：它只是把顺序 ID 换成不透明 ID。分享需要独立的令牌、独立的访问路径、只读快照序列化和撤销能力（Part B）。

---

## Part A — `public_id` 标识符加固

### A.1 范围

| 实体 | 是否加 `public_id` | 说明 |
|---|---|---|
| `conversations` | ✅ 必需 | 深链、分享、列表/详情寻址 |
| `runs` | ✅ 推荐 | URL path `/runs/{...}`；`SendMessageResponse.run` 与 SSE 流引用 |
| `messages` | ✅ 推荐 | edit/regenerate path 中的 `{message_id}`；用户明确提到 `message_id` |
| `users` / `run_events` / `*_tokens` | ❌ 不做 | 不按 ID 对外寻址（`run_events` 在 run 内用 `seq` 定位）；`users.id` 仅返回给本人，低风险 |

**推荐一次性把 conversation + run + message 三者都加上**，理由：避免"会话用 UUID、消息/run 用数字"的半截状态（响应体里 `conversation_id` 是 UUID 而 `run_id` 是数字会非常混乱）；三者是同一套机械模式套用三次。（已确认 D1：全做。）

### A.2 数据模型与迁移

每张目标表新增一列（以 conversations 为例，runs/messages 同构）：

```python
# app/models/conversation.py
import uuid
from sqlalchemy.dialects.postgresql import UUID as PGUUID

public_id: Mapped[uuid.UUID] = mapped_column(
    PGUUID(as_uuid=True),
    nullable=False,
    unique=True,
    default=uuid.uuid4,           # 应用侧生成，可测试、DB 无关
    server_default=text("gen_random_uuid()"),  # 兜底裸 INSERT / 回填
)
```

迁移（新 revision `20260618_0006`，`down_revision = 20260611_0005`），对 conversations/runs/messages 各做一遍：

1. `op.add_column(..., sa.Column("public_id", postgresql.UUID(as_uuid=True), nullable=True))`
2. 回填：`UPDATE <table> SET public_id = gen_random_uuid() WHERE public_id IS NULL;`（pg16 内置）
3. `op.alter_column(..., nullable=False)`
4. `op.create_unique_constraint("uq_<table>_public_id", "<table>", ["public_id"])`（唯一约束自带唯一索引，按 `public_id` 查询走索引）

`downgrade()`：反向 drop 约束与列。

### A.3 ID 格式与生成

- **格式**：UUIDv4，存 PG 原生 `uuid` 类型。理由：随机不可预测（满足防枚举）、碰撞概率可忽略（**无需插入重试**）、生态成熟、`uuid` 列比 `text` 紧凑。
- **不选 UUIDv7**：可排序但会泄露大致创建时间，与"防信息泄露"初衷相悖。
- **不选短 token（nanoid/base62）**：URL 更短，但需要处理唯一冲突重试。（已确认 D2：用 UUIDv4，不用短 token。）
- **生成位置**：应用侧 `default=uuid.uuid4`（清晰、可测试），同时挂 `server_default=gen_random_uuid()` 兜底。

> 注意：`public_id` 是标识符不是密钥，它**不是**访问防线（防线仍是 `user_id` 校验）。真正的 bearer 秘密只在 Part B 的分享令牌里，用更高熵。

### A.4 服务层解析策略：边界解析为内部 bigint

**原则：在每个 service 函数入口把 `public_id` 解析为内部 `Conversation`/`Run`/`Message` 对象（拿到 bigint `id`），之后所有既有逻辑、内部查询、FK 全部保持按 bigint 运作。** 这样内部改动最小。

改动点（`app/services/conversations/service.py`、`app/services/runs/service.py`）：

- `get_owned_visible_conversation(...)` / `..._for_update`：参数从 `conversation_id: int` 改为 `public_id: uuid.UUID`，WHERE 改为 `Conversation.public_id == public_id AND user_id == ...`（走唯一索引）。返回的对象仍带内部 `id`，后续 `Message.conversation_id == conversation.id` 等内部查询**不变**。
- `_get_owned_unarchived_message_for_update(...)`：按 `Message.public_id == message_public_id AND conversation_id == <内部 id>` 解析。
- `get_owned_visible_run` / `cancel_owned_run`：按 `Run.public_id == run_public_id` join 解析。
- 响应序列化（`message_response` / `run_response` / `conversation_response`）：把对外字段改为输出 `public_id`；跨实体引用字段（`conversation_id`、`run_id`、`user_message_id`）也要映射成对应实体的 `public_id`（需要把关联对象的 public_id 取出来，注意避免 N+1：在已加载对象上取即可）。
- `submit_user_message` 等返回的 `SendMessageResponse.run.id` 改为 run 的 `public_id`，前端据此拼 `/runs/{run_public_id}/events`。

`pg_notify('runs_queued', str(run.id))` 等**保持内部 `run.id` 不变**（worker 内部消费）。

### A.5 API / schema 改动

- Path 参数类型从 `int` 改为 `uuid.UUID`（FastAPI 自动校验 UUID 格式，非法格式直接 422）。
- 路由签名 `conversation_id: int` → `conversation_public_id: uuid.UUID`，传入 service。
- `app/schemas/conversations.py` / `runs.py`：
  - `ConversationResponse.id: int` → `id: uuid.UUID`（对外字段名仍叫 `id`，类型变为 UUID，前端最小改动）。
  - `MessageResponse`：`id`、`conversation_id`、`run_id` 全部 → `uuid.UUID`（`run_id` 仍可空）。
  - `RunResponse`：`id`、`conversation_id`、`user_message_id` → `uuid.UUID`。
  - `RunStateResponse.run_id` → `uuid.UUID`。
  - `RunEventResponse` 无 ID 字段（只有 `seq`），无需改。

> 决定：对外字段名沿用 `id` / `conversation_id`（仅类型由 number 变 UUID 字符串），不新增 `public_id` 字段名，以减少前端与契约的改动面，并彻底移除数字 ID（不并存）。

### A.6 前端改动

- **类型**（`frontend/src/api/types.ts`）：相关 `id` / `conversation_id` / `run_id` / `user_message_id` 由 `number` 改为 `string`。
- **API 客户端**（`frontend/src/api/conversations.ts`、`runs.ts`）：函数签名 `conversationId: number` → `string`，URL 拼接不变（模板字符串）。
- **路由（新增，当前完全没有）**：引入 **React Router v7（库模式，`react-router-dom`）**，用 `createBrowserRouter` + `RouterProvider`。两类路由：
  - 所有者应用：`/` 与 `/c/{conversation_public_id}`（需登录）。进入 `/c/:id` 时按 public_id 加载详情；切换会话用 router 导航更新 URL；刷新可深链恢复。
  - 公开分享页：`/share/{token}`（无需登录，见 Part B）。
  - 具体版本号实施时按 `pnpm` 实际可用最新版锁定。
- **selectionStore**（`frontend/src/conversations/selectionStore.ts`）：值由数字改为字符串 public_id；**更换 storage key**（如 `ichat.selectedConversationPublicId`）使旧的数字值自然失效，避免读到无效旧值。
- 受影响测试与 fixtures：`apiFixtures.ts`、各 `*.test.tsx` 中硬编码的数字 ID 改为 UUID 字符串。

---

## Part B — 会话分享

### B.1 数据模型：`share_links` + 快照

新增表 `share_links`：

```python
class ShareLink(Base):
    __tablename__ = "share_links"
    id: Mapped[int]                      # bigint PK，内部
    token: Mapped[str]                   # secrets.token_urlsafe(32)，unique，URL 中的 bearer 秘密
    conversation_id: Mapped[int]         # FK -> conversations.id, ondelete=CASCADE
    created_by: Mapped[int]              # FK -> users.id
    snapshot: Mapped[dict]               # JSONB：分享时刻的 {title, messages:[...]}
    revoked_at: Mapped[datetime | None]
    expires_at: Mapped[datetime | None]  # 可空 = 永不过期
    created_at: Mapped[datetime]
    # 索引：unique(token)；index(conversation_id)
```

**快照 vs 实时**：v1 采用**创建时快照**（snapshot 存 JSONB），不随会话后续编辑/新增而变化。理由：
- 隐私安全 —— 分享后你继续说的话**不会**泄露给持链人（符合 ChatGPT 等产品的"分享到此为止"心智）。
- 实现简单 —— 公开读接口只回 `snapshot`，与活会话/鉴权完全解耦；撤销 = 置 `revoked_at`。
- 抗编辑 —— 不依赖 `position`/`archived_at`（会话编辑会 archive 消息），快照天然不受影响。

代价：快照不更新。需要更新就重新分享（生成新链接）。实时视图非本期范围（v2）。

快照内容序列化：复用 `message_response` 的字段裁剪后写入。**暴露字段**：`title`、每条消息的 `role` / `content` / `reasoning`（思维链，与所有者所见一致）/ `metadata.sources`。**不含** 内部 ID 与 user 身份信息。

### B.2 接口

**公开只读（不鉴权，匿名可访问）**
- `GET /api/v1/share/{token}` → `{ title, messages: [...], created_at }`
  - 故意**不依赖** `get_current_user`，这是有意为之的鉴权绕过，作用域严格限定为返回该 `snapshot`。
  - token 未知 / 已 `revoked_at` / 已过期 → 404（统一用 `AppError(404, "Share not found")`，不区分原因以免探测）。
  - token 高熵，枚举不可行；仍建议加基础限流（见实施边界）。

**管理（鉴权，仅会话所有者）** —— 挂在 conversations 下：
- `POST /api/v1/conversations/{conversation_public_id}/shares` → 创建分享（此刻生成快照）。请求体可选 `expires_in_days`（或 `expires_at`）；省略 = 永不过期。**支持对同一会话创建多份链接**（不同时刻的快照、不同过期）。返回 `{ token, url, expires_at, created_at }`。
- `GET  /api/v1/conversations/{conversation_public_id}/shares` → 列出该会话的全部分享（token 前缀/状态/过期/创建时间），用于管理面板与撤销。
- `DELETE /api/v1/conversations/{conversation_public_id}/shares/{share_token}` → 撤销（置 `revoked_at`，幂等）。

所有管理接口先经 `get_owned_visible_conversation` 校验所有权。

### B.3 鉴权与隐私

- 公开读接口是系统中**唯一**绕过 `user_id` 校验的路径，必须严格只读、只回快照、不暴露内部 ID（快照里也用 public_id 或干脆不带 ID）。
- 不在快照中包含 user 身份信息（用户名/邮箱）。
- 撤销后立即 404；过期同理。

### B.4 前端

- **公开分享页 `/share/{token}`**：独立页面，**不需要登录态**，复用 `Markdown` / `Message` / `MessageThread` / `SourcesPanel` 渲染只读消息列表；无 Composer、无操作按钮。顶部可放"这是一个分享的只读会话 + 注册/登录入口"。
- **分享入口**：在 `Topbar`/会话菜单加"分享"动作 → 弹窗（复用 `ui/` 的对话框）：创建链接（可选过期时长）、复制链接、列出已有链接并可撤销。
- 分享页要能被未登录用户、爬虫直达，注意它在 CF Pages 的 SPA fallback 路由配置（`/share/*` 也要回 `index.html`）。

---

## 内部不变量（明确不动）

- 主键、外键、`(conversation_id, position)`、`(run_id, seq)` 等内部索引：**保持 bigint**。
- Worker claim/lease/heartbeat、`pg_notify` 载荷（`str(run.id)`）：**用内部 bigint，不变**。
- run 状态机、SSE seq 分配、`after_seq` 重放语义：不变。
- DeepSeek/provider 侧的 `provider_request_id`、`tool_call_id`：非本系统主键，不在范围。

## 实施阶段与顺序

1. **Phase 1 — public_id 加固**：迁移（conv+run+msg）→ 模型 → service 入口解析 → schema/路由 path 类型 → 前端 types/client/selectionStore → React Router 路由 `/c/{public_id}`。验证：后端 pytest 全绿、前端 vitest/typecheck/build 全绿、手动深链刷新恢复。
2. **Phase 2 — 分享**：`share_links` 迁移 → 模型/service（创建快照、公开读、撤销、过期、多份）→ 公开 `GET /share/{token}` + 管理接口 → 前端 `/share/{token}` 只读页 + 分享 UI。

> Phase 1 一次做全（conv+run+msg，已确认 D1），Phase 2 紧随其后。

## 兼容性与上线

- 前后端跨域分离部署（后端 server，前端 CF Pages）。`public_id` 是**破坏性契约变更**（path 参数与响应字段类型变化），不做新旧并存。
- 单人控制双端，采用**硬切换**：先部署后端（接受 UUID path），再部署前端。切换窗口内旧前端会失效（数字 ID 打到期望 UUID 的后端 → 422/404），属可接受的短暂窗口。
- 新分享页路由 `/share/*` 需加入 CF Pages 的 SPA fallback；如分享页将来用独立子域，记得同步后端 `CORS_ALLOWED_ORIGINS`（见 CLAUDE.md 部署须知）。

## 验证

- **后端**：`pytest`（新增/改写：public_id 解析、未知/跨用户/软删返回 404、UUID 非法格式 422；分享创建/撤销/过期、匿名只读、快照不随后续编辑变化）、`ruff check app tests`、`mypy app`、`docker compose exec api alembic upgrade head` 后 `alembic downgrade` 往返可逆。
- **前端**：`pnpm exec vitest run`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`。
- **手动 smoke**：创建会话→复制 `/c/{public_id}` 刷新可恢复；分享→无痕窗口打开 `/share/{token}` 只读可见；撤销后该链接 404；编辑原会话后分享内容不变。

## 已定决策

- **D1｜public_id 范围**：✅ conversation + run + message 一次做全（Phase 1）。
- **D2｜ID 格式**：✅ UUIDv4，存 PG 原生 `uuid`，应用侧 `default=uuid.uuid4` + `server_default=gen_random_uuid()` 兜底，无冲突重试。
- **D3｜前端路由**：✅ React Router v7（库模式 `react-router-dom`，`createBrowserRouter` + `RouterProvider`），版本实施时锁最新可用。
- **D4｜分享语义**：✅ 创建时快照（JSONB），分享后续发言不泄露；实时视图非本期范围。
- **D5｜分享包含 reasoning**：✅ 纳入（`title` + `role`/`content`/`reasoning`/`sources`），与所有者所见一致；不含内部 ID 与 user 身份。
- **D6｜过期 / 多份**：✅ 支持。`share_links` 有 `expires_at`（可空=永久）；同一会话可多份；提供创建（可选过期）、列表、撤销接口与 UI。

## 实施边界（本设计不做的事）

- 不改内部主键/外键/notify/seq。
- 不做"实时协作/可写分享"（仅只读快照）。
- 不做精细化分享权限（按人授权、密码保护）——如需，作为后续迭代。
- 限流仅做基础防护（公开读接口），不引入额外组件。
