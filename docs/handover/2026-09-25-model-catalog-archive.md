# 模型目录归档与控制台列表 + 详情布局

计划：`docs/plans/2026-09-12-model-admin-archive-and-layout.md`；决策：ADR `0014-archive-catalog-rows-instead-of-hard-delete.md`。

## 状态

| 部分 | 状态 |
|---|---|
| 后端：迁移、ORM、服务层、API、CLI、测试 | 已完成并验证 |
| Design：三版候选比较，用户选定 `admin-master-detail` 并晋升为 current | 已完成，确认记录 `design/approvals/2026-09-25-admin-master-detail.json` |
| 正式前端：API 客户端、归档/恢复交互、列表 + 详情布局 | 已完成并验证 |

后端与正式前端必须一起上线：旧前端不识别 `archived`，会把归档项当成普通条目展示（同名 key 时还会出现重复项）。

## 结果

聊天模型、模型路由、模型上游可以归档和恢复，行永不删除。归档释放自然 key，同名可立即重建；归档项按 `ref` 恢复。在途 Run 改为按快照 `route_id` 解析凭据，不受归档或同名重建影响。

### 数据

迁移 `20260925_0025`：三表加 `archived_at timestamptz NULL`；`uq_chat_models_key`、`uq_model_upstreams_key`、`uq_model_routes_model_upstream_remote_model` 替换为 `ux_*_active` 部分唯一索引（`WHERE archived_at IS NULL`）。downgrade 在存在同 key 多行时直接报错，不丢数据。

### 规则

| 动作 | 前置条件（否则 409） | 效果 |
|---|---|---|
| 归档模型 | — | 级联归档其未归档路由，写入与模型相同的 `archived_at` |
| 归档路由 | — | 仅该路由 |
| 归档上游 | 没有未归档路由引用它 | 仅该上游；409 消息列出阻塞路由三元组 |
| 恢复模型 | 无同 key 活跃模型 | 恢复同批（`archived_at` 相同）且上游活跃的路由 |
| 恢复路由 | 父模型、父上游均活跃；无同三元组活跃路由 | 仅该路由 |
| 恢复上游 | 无同 key 活跃上游 | 仅该上游 |

归档行只读：所有编辑、启停、upsert 只命中活跃行，upsert 不会复活归档行。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| PATCH | `/api/v1/model-admin/models/{key}/archived` | `{"archived": true}`；`false` 返回 422 并指向恢复端点 |
| PATCH | `/api/v1/model-admin/upstreams/{key}/archived` | 同上 |
| PATCH | `/api/v1/model-admin/routes/archived` | 三元组 + `{"archived": true}` |
| POST | `/api/v1/model-admin/archive/{ref}/restore` | 恢复任一归档项 |

目录响应（含归档项）每项新增 `ref`、`archived`、`archived_at`；路由另加 `model_ref`、`upstream_ref`。`archived_at` 让前端判断恢复模型会带回哪些路由（与模型时间戳相同者）。冲突为 409（`ModelCatalogConflictError`，以及部分唯一索引并发冲突的 `IntegrityError`），其余目录校验仍为 422，均回滚。

CLI：`archive --model KEY | --upstream KEY | --route MODEL UPSTREAM UPSTREAM_MODEL`、`restore --ref REF`、`archived`（列出归档项与 ref）；`status` 只显示活跃项。

## 链路与定位

```
① 管理写入   控制台 / CLI → api/v1/model_admin.py (_mutate) → model_catalog/management.py
② 目录读取   capabilities / 创建 Run → service._database_chat_models（过滤归档）→ snapshot() → runs.model_config_snapshot
③ Run 执行   worker/executor.py → service.resolve_run_model_runtime（route_id → upstream，不看归档）
④ 控制台展示 management.catalog_inventory（含归档）→ _catalog_response（archived + ref）→ 控制台
```

| 现象 | 先查 |
|---|---|
| 已归档项仍可选 / 仍出现在 capabilities | ② `_database_chat_models` 过滤 |
| 在途 Run 报 "route no longer exists" 或凭据不对 | ③ `resolve_run_model_runtime` |
| 编辑/启停命中归档行，或"改了不生效" | ① `_*_by_key`、`_active_route`、`upsert_*` 的过滤 |
| 归档或恢复 409 | ① `management.py` 规则，消息写明原因 |
| 目录激活校验因归档项失败 | `_validate_active_routes` 过滤 |
| 归档或新建 500 | `_mutate` 未把 `IntegrityError` 映射为 409 |
| 控制台同名串位、恢复错对象 | 前端未用 `ref`，或 `_catalog_response` 漏填 ref 字段 |

## 控制台布局

用户在三版候选（`admin-master-detail` / `admin-segmented` / `admin-minimal`）中选定列表 + 详情，已晋升为 Design current 并实施到正式前端；落选候选已删除，比较过程见 git 历史与确认记录。

- 左侧：模型/上游分段、搜索（切换分段时清空）、添加入口、条目行（状态点 + 名称 + key + 路由数）、底部「已归档」入口。
- 右侧：所选项详情。模型为状态开关、编辑、归档、能力 pills 与完整路由轨道（含每条路由的归档）；上游为 endpoint/adapter/hint 与「引用该上游的路由」。未显式选择时显示分段内第一项；编辑某项后固定选中它，避免保存后目录重排导致详情跳到另一项。
- 「已归档」：`ArchivedList` 按 `ref` 列出归档模型、上游和单独归档的路由（随模型归档的路由经由模型恢复）。
- 窄屏（< lg）：先显示列表，点选后切换为详情并滚动到详情顶部，「返回列表」回到列表。
- 确认流程集中在 `archiveActions.tsx`：归档写明级联路由数；上游仍被引用时预先说明服务端会拒绝；恢复模型按 `archived_at` 预告会带回和保持归档的路由数，同 key 已有活跃模型时预先说明冲突。服务端 409 消息原样显示在通知区。

文件（Design 与正式前端同名同内容，仅 `ModelAdminPage.tsx` 的 context 导入不同）：`ModelAdminDashboard.tsx`、`archiveActions.tsx`、`ArchivedList.tsx`、`ModelAdminControls.tsx`、`catalogView.ts`。正式前端 API 客户端新增 `archiveModel` / `archiveUpstream` / `archiveRoute` / `restoreArchived(ref)`。Design 场景 `admin-dense`（12 模型 / 6 上游 / 22 路由，含 `gpt-5` 同 key 活跃 + 归档并存）已加入配对列表。

## 验证

本次已完成：

```bash
uv run ruff check .
uv run mypy app
DATABASE_URL=<isolated-db> uv run alembic upgrade head    # 另做 downgrade -1 → upgrade head 往返与重复 key 拒绝降级
<全部 *_TEST_DATABASE_URL 指向隔离库> uv run pytest -q --ignore=tests/services/agents/test_prompts.py
pnpm --dir design lint && pnpm --dir design typecheck && pnpm --dir design test --run
pnpm --dir design check:boundaries
pnpm --dir frontend exec tsc -p tsconfig.design-reference.json
pnpm --dir design test:visual     # 116 passed
pnpm --dir design test:parity     # 56 passed（含 admin-dense）
pnpm --dir design catalog
(cd frontend && pnpm run lint && pnpm run typecheck && pnpm exec vitest run && pnpm run build)   # 734 passed
```

- ruff、mypy（145 个源文件）通过；模型目录服务 + metadata 37 项、模型管理 API 13 项通过。
- 全量后端：780 passed，另有 1 failed + 11 errors 在未改动代码上同样复现，与本次无关：`tests/services/email/test_outbox.py` 的 `MissingGreenlet`，以及 `test_capabilities_endpoint_is_public_and_hides_provider_name` 中依赖环境的 `conversation_search.enabled`。
- 各测试文件按各自的 `*_TEST_DATABASE_URL` 连接，默认回落开发库 `ichat`；开发库未迁移到 `0025` 时会报 `archived_at does not exist`。本次全部指向隔离库，未改动开发库。
- 候选阶段在真实 Chromium 中检查了三版 `admin-dense`：1440×900 与 390×844 均无横向滚动。
- 正式前端端到端冒烟：用新 CLI 在隔离库造数（含 `gpt-5` 归档后同名重建、归档上游 `legacy-proxy`），真实 API（临时管理密钥与加密密钥，经环境变量覆盖）+ 前端 dev server，headless Chromium 1440×900 与 390×844：
  - 两种尺寸均无横向滚动，锁定入口常驻；窄屏详情的归档、编辑、启停、返回全部可见，点选后详情在视口内；
  - 恢复同 key 的旧 `gpt-5` → 确认框预警 + 服务端 409；归档仍被引用的 OpenRouter → 409 并列出两条路由；
  - 归档 Gemini 3（级联 1 条路由）→ 恢复 → 路由回到轨道；恢复 `legacy-proxy` 成功；
  - 目录响应不含密文；控制台错误只有上述两次预期的 409 网络响应。

## 待办

- 提交后在确认记录中补齐 `designCommit` 与 `implementationCommit`。
- 上线前在目标环境执行迁移，并确认前后端同批发布。

## 上线与回滚

迁移只新增可空列并放宽唯一约束，在没有归档行之前与旧约束等价，可安全 expand；归档是纯数据库状态，提交即生效，不需要重启。

回滚代码时保持数据库 expand。旧代码不识别 `archived_at`，归档行会重新出现在目录中；若某 key 已存在归档行与活跃行，旧代码按 key 查询结果不确定（包括旧版 `resolve_run_model_runtime`），回滚前应让每个 key 只剩一行。不建议 downgrade。
