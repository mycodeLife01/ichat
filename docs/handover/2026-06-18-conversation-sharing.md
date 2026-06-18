# 实现纪录：会话分享（Phase 2 —— share_links + 公开只读页）

日期：2026-06-18
分支：`feat/public-id-sharing`
设计依据：[`docs/superpowers/specs/2026-06-18-public-id-and-conversation-sharing-design.md`](../superpowers/specs/2026-06-18-public-id-and-conversation-sharing-design.md)（Part B）
前置：[`docs/handover/2026-06-18-public-id-hardening.md`](2026-06-18-public-id-hardening.md)（Phase 1，public_id + `/c/:publicId` 深链）

## 范围

让会话所有者把一段会话「分享」为可复制的只读链接，任何持链人（含匿名）访问该会话**创建时刻的快照**。这是与 `public_id` **完全分离**的第二套机制：

| | `public_id`（Phase 1） | 分享令牌 `token`（本次） |
|---|---|---|
| 作用 | 所有者接口/URL 上标识会话 | 任何持链人只读访问会话快照 |
| 鉴权 | 仍受 `user_id` 所有权校验 | **故意绕过**所有权校验，作用域限定为只读快照 |
| 可撤销/过期/重新分享 | 否 | 是（同会话同时仅一个有效，撤销后可再建） |
| 熵 | UUIDv4 标识符 | `secrets.token_urlsafe(32)`（~256 bit bearer 秘密） |

核心原则：
- **快照在创建时冻结**（JSONB）：分享后续的编辑/新增消息**不会**泄露给持链人；快照取「未归档、按 position 排序」的消息（与 `get_conversation_detail` 同一查询），天然抗后续编辑（编辑会 archive 旧消息，不动快照）。
- **快照只含** `title` + 每条消息 `role`/`content`/`reasoning`/`sources`，**不含**内部 ID、run id、position、时间戳、user 身份。
- **公开读接口是系统中唯一绕过 `user_id` 校验的路径**，严格只读、只回 `snapshot`。
- **每个会话同时只能有一个有效（未撤销、未过期）分享链接**（覆盖原 spec D6 的「多份」）：已存在有效链接时再次创建返回 **409**，需先撤销。撤销/过期的行**保留在表中仅供审计**，但对所有者列表与前端**不可见**。

## 关键文件

### 后端

- `app/models/conversation.py`：新增 `ShareLink`（**全 bigint，无 `public_id`/UUID 列**——token 即对外句柄）。列：`id` bigint PK、`token` `String(64)` unique（值 43 字符）、`conversation_id` FK→conversations.id `CASCADE`、`created_by` FK→users.id `CASCADE`、`snapshot` JSONB not-null、`revoked_at`/`expires_at` 可空 tz-aware、`created_at`。索引 `ix_share_links_conversation_id`。在 `app/models/__init__.py` 注册（metadata 测试依赖）。
- `alembic/versions/20260618_0007_add_share_links.py`：`down_revision=20260618_0006`。`create_table` + `downgrade=drop_table`，已验证可逆。
- `app/schemas/shares.py`：`ShareCreateRequest`（`expires_in_days: int|None`，`gt=0,le=365`）、`SharedSource`/`SharedMessage`（镜像 `MessageSource`/前端渲染所需）、`PublicShareResponse`（`title`/`messages`/`created_at`）、`ShareLinkResponse`（**完整 token** + `expires_at`/`revoked_at`/`created_at`，**无内部 id/user**）。
- `app/services/shares/service.py`：
  - `create_share`：`get_owned_visible_conversation_for_update` **锁会话行**（让并发创建串行化）→ 查是否已有「有效」链接（`_active_share_filter`：未撤销且未过期），有则 **409 `Active share already exists`** → 取未归档消息 → `_build_snapshot`（手工 dict，**绝不**塞 `MessageResponse`）→ `token=secrets.token_urlsafe(32)`，`expires_at = get_database_now() + timedelta(days=...)` 或 `None`。
  - `list_shares`：owner 校验后**只返回有效链接**（`_active_share_filter`，至多一条）；撤销/过期行保留供审计但不展示。
  - `revoke_share`：owner 校验；`(token, conversation_id)` 查不到→404；已撤销→**幂等** ok；否则置 `revoked_at`。
  - `get_public_share`：**无 user 参**。`share is None / revoked / expired(用 DB now 比较)` → 统一 `AppError(404, "Share not found")`（不区分原因，防探测）。
  - `_active_share_filter(now)`：`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`——「有效」的唯一判定，create/list 共用。
- `app/api/v1/conversations.py`：管理三件套（`get_current_user` + 路由层 `session.commit()`）：`POST/GET /{conversation_id}/shares`、`DELETE /{conversation_id}/shares/{share_token}`。
- `app/api/v1/share.py`（新）：`GET /api/v1/share/{token}` —— **无任何 auth 依赖**（参考 `capabilities.py`），返回 `SuccessResponse[PublicShareResponse]`（**必须**走标准 envelope，前端 `ApiClient` 强制解 `payload.data`）。在 `app/main.py` `include_router`。

### 前端

- `frontend/src/api/types.ts`：新增 `ShareLinkResponse`/`SharedSource`/`SharedMessage`/`PublicShareResponse`。
- `frontend/src/api/share.ts`（新）：`createShareApi`，`create/list/revoke/getPublic`。**`getPublic` 用 `{auth:false, retryOnUnauthorized:false}`**（匿名读，不带 Authorization，登录所有者也不泄露 token）。
- 服务注入：`app/context.ts`（`Services.shareApi`）、`app/AppProvider.tsx`（`createShareApi(client)`）、`test/appHarness.tsx`（`createFakeShareApi` + `createFakeServices` 第 5 个可选位置参）、`test/apiFixtures.ts`（`shareLinkResponse`）。
- **路由重构** `frontend/src/app/App.tsx`：拆出 `AuthGate`。`<Routes>`：`/share/:token`→`<SharePage/>`（**在 `bootstrapped` 门之外**，匿名不等待 auth），`*`→`<AuthGate/>`（保留原 `isAuthenticated ? AppShell : AuthScreen`）。`*` 兜底使 AppShell 在 `/`、`/c/*` 全程保持挂载，其 `useLocation` 正则解析与 bootstrap 不变。
- `frontend/src/messages/SharePage.tsx`（新）：`useParams` 取 token → `services.shareApi.getPublic` → loading/error(404→「分享不存在或已失效」)/ready 三态。**不复用 `<Message>`**（它无条件渲染编辑/重发/复制操作栏），而是用 `Markdown` + `ThinkingBlock` + 复刻的 user 气泡/阅读列容器（`max-w-[var(--reading-width)]`）渲染；自持 `SourcesPanel` 状态（AppShell 不在此页）。`SourcesTrigger` 从 `Message.tsx` 导出复用。顶部 banner + 「登录 iChat」入口。
- `frontend/src/ui/ShareDialog.tsx`（新，复用 `dialog-backdrop`/`dialog`/`ghostBtn`/`primaryBtn`）：进入 `list` 取有效链接（至多一条）。**无有效链接**时显示过期预设（7天/30天/永不）+「创建链接」→ 创建后展示并自动复制链接（`${window.location.origin}/share/${token}`）；**已有有效链接**时隐藏创建区，只展示该链接 + 复制 + 撤销，并提示「每个对话同时只能有一个有效链接，撤销后即可新建」。撤销后创建区重现。Toast 反馈。
- `frontend/src/ui/state.ts`：`shareDialog: {conversationId}|null` + `ui/openShare`/`ui/closeShare`（仿 `confirmDialog`）。
- 入口：`Sidebar.tsx` `rowActions` 在 重命名/删除 间插「分享」+ 新 prop `onRequestShare`；`AppShell.tsx` 透传并在 `ConfirmDialog` 旁渲染 `<ShareDialog>`。`ui/icons.tsx` 新增 `Share`(lucide `Share2`)。
- `frontend/public/_redirects`（新）：`/*  /index.html  200`，CF Pages SPA fallback，保证匿名/爬虫直达 `/share/<token>`（一并兜底 `/c/*`）命中 `index.html`。已确认 build 后落入 `dist/`。

## 设计要点回顾

- **为什么快照而非实时**：隐私（分享后续发言不泄露）、实现简单（公开读只回 snapshot，与活会话/鉴权解耦）、抗编辑（不依赖 position/archived_at）。代价：快照不更新，需更新就重新分享。
- **为什么 `share_links` 不加 `public_id`**：token 本身就是高熵对外句柄；加 UUID 列反而会让 `test_uuid_columns_are_limited_to_public_ids` 不变量失败。
- **快照绝不存 `MessageResponse`**：那会带 `id`/`conversation_id`/`run_id`/`position`/`created_at`，正是 spec 禁止泄露的内部句柄。手工构造 dict。
- **`metadata_["sources"]` 与 `MessageSource` 字节级一致**（见 `app/search/postprocess.py:SourceRecord.metadata()`），快照原样存、前端 `Markdown`/`SourcesPanel` 直接用，零转换。
- **公开读必须走 `SuccessResponse` envelope**：前端 `ApiClient.request` 无条件解 `payload.data`，否则抛「服务响应格式异常」。
- **过期比较用 DB now**（`get_database_now`）而非 `datetime.now(UTC)`：`expires_at` 是 tz-aware，统一时间源避免时钟偏移。
- **每会话至多一个有效链接**：不用 DB 偏索引（partial unique index 无法表达「随时间变化的过期」），改为 `create_share` 里 `SELECT ... FOR UPDATE` 锁会话行 + 应用层「无有效链接」检查 + 插入三步原子化。撤销/过期不删行，仅靠 `_active_share_filter` 在 create/list 时过滤，历史记录留存供审计。

## 验证

```bash
# 迁移（宿主机覆盖 DATABASE_URL 指向 localhost；docker 内不必）
DATABASE_URL="postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat" uv run alembic upgrade head
# 可逆性：alembic downgrade -1 && alembic upgrade head 已验证

# 后端（本地测试与 docker worker 共用 ichat 库，跑前先 docker compose stop worker，
# 跑完 docker compose up -d --no-deps worker）
uv run pytest            # 259 passed
uv run ruff check app tests
uv run mypy app

# 前端（frontend/ 内）
pnpm exec vitest run     # 304 passed
pnpm run typecheck
pnpm run lint
pnpm run build           # 同时确认 dist/_redirects 存在
```

本次实测：后端 **259 passed**（Phase 1 为 242），ruff/mypy 干净；前端 **304 passed**（Phase 1 为 295），typecheck/lint/build 全绿。另用 ASGI in-process 跑通真实库端到端：创建（7 天过期）→ 二次创建 409 → 列表仅 1 条有效 → 撤销 → 列表 0 条 → 再次创建 201（新 token）；以及匿名读快照、撤销后匿名读 404。

新增/改写测试：
- `tests/api/test_shares.py`：创建+匿名读快照（断言不含内部 id）、列表仅返回有效链接、**已有有效链接时二次创建 409**、**撤销后可再创建**、撤销后 404 + 幂等撤销 + 撤销行从列表隐藏、过期 404 + 过期行从列表隐藏 + 过期后可再创建、快照抗编辑、未知 token 404、管理接口需鉴权、跨用户管理 404、`expires_in_days` 边界 422、缺失会话 404。
- `tests/services/shares/test_share_service.py`：快照排除内部 id、过期从 DB now 计算、幂等撤销阻断公开读、过期阻断公开读。（**文件名带 `share_` 前缀**——repo 测试目录无 `__init__.py`，模块 basename 必须全局唯一，否则 pytest 收集冲突。）
- `tests/models/test_metadata.py`：`test_core_tables_are_registered` 加 `share_links`；新增 `test_share_links_are_bigint_token_keyed_snapshots`。
- 前端 `App.test.tsx`（匿名 `/share/:token` 渲染、不出登录页）、`SharePage.test.tsx`、`ShareDialog.test.tsx`（无有效链接→创建；已有有效链接→只读+撤销、隐藏创建；撤销→创建区重现）、`api/share.test.ts`、`icons.test.tsx`（加 `Share`）。

## 部署说明

- **必须重建镜像**：当前线上/本地容器镜像早于本迁移与 `/share` 路由。push 到 `main` 后 deploy workflow 用新镜像跑 migrate（`20260618_0007`）。本地恢复 worker 用 `docker compose up -d --no-deps worker`（worker 旧代码靠 `server_default` 兼容新 schema；但新 `/share` 路由需 API 新镜像）。
- 跨域：`chat.feslia.com` 已是 allowed origin，匿名 `GET /api/v1/share/{token}` 是已放行 origin 的普通 CORS GET（无 Authorization），**无需改 `CORS_ALLOWED_ORIGINS`**。
- CF Pages：`frontend/public/_redirects` 已加 `/*  /index.html  200`，确保匿名直达 `/share/<token>` 命中 SPA。

## 已知局限 / 待办

- **公开读暂未加限流**（spec 标「仅基础防护」；token ~256 bit 高熵已使枚举不可行）。后续可加 per-IP throttle。
- 不做实时视图 / 可写分享 / 按人授权 / 密码保护（spec 明确排除）。
- 端到端 Playwright（真实浏览器）未跑，目前以单元/组件/ASGI in-process 覆盖。
- `share_links` 删除随会话 `CASCADE`；会话软删（`deleted_at`）时 `get_owned_visible_conversation` 即 404，管理接口随之不可用，但已存在的公开链接仍可读（快照独立）——符合「分享是独立凭证」语义，撤销才是停用手段。
