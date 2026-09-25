# 模型管理归档能力与控制台布局改版方案

日期：2026-09-12（2026-09-25 修订：Run 改按 `route_id` 解析凭据，归档语义对齐外键语义，寻址统一为 `ref`）
状态：已实施并验证（2026-09-25，用户选定 `admin-master-detail`；见 `docs/handover/2026-09-25-model-catalog-archive.md`）

## 目标

模型管理控制台 `/model-admin` 当前缺少删除能力，且条目一多就退化成单列长页。本轮补齐两件事：

1. 模型、模型路由、模型上游均可从控制台移除，并可从移除状态恢复。
2. 控制台在密集目录下仍可管理：能定位、能筛选、能折叠，不再只靠一条垂直滚动。

布局改版先以三版候选在独立 Design 工程中交付，由用户选定后再实施到正式前端。归档能力与布局无关，可并行实施。

## 与既有决策的冲突

`docs/handover/2026-08-29-database-model-catalog.md:39` 与 `docs/architecture/frontend.md:122` 均写明「Web 与 CLI 都不提供 hard delete」，理由是 Run 执行期语义：

- Run 创建时只固化**不含凭据**的配置快照（`runs.model_config_snapshot`，v2）。
- Run 执行时由 `resolve_run_model_runtime` 按 `snapshot["upstream"]` 这个 **key** 回查 `model_upstreams.api_key_ciphertext`（`app/services/model_catalog/service.py:202-206`）。
- 上游行被删除后该查询落空，抛 `ModelCatalogError("Run model upstream no longer exists")`，所有引用它的在途 Run 直接失败。

按 `docs/agents/domain.md` 的 ADR 冲突规则，本轮不静默覆盖该决策，而是以**归档**替代物理删除：行永不删除，凭据始终可解密；归档项从可用目录中消失，达到"从列表里拿掉"的产品目的。该结论记录为新 ADR，并回改上述两处文档。

已核实**历史** Run 不受影响：ADR 0013 的 Provider 续传亲缘性由 `runs.model_config_snapshot` 推导（`_route_affinity`，`app/services/runs/history.py:204-254`），不 join 实时目录表。

**key 必须释放**：归档行的 key 不能继续占用唯一约束，否则"归档后重建同名"会失败。三处唯一约束改为只约束未归档行的部分唯一索引（见「数据模型」）。代价是同一个 key 可以同时存在一条活跃行和任意多条归档行，因此管理面统一改用 `ref` 句柄（`model-12` / `upstream-4` / `route-31`）寻址具体行。

**Run 执行改按 `route_id` 解析凭据**：key 可复用后，按 key 回查上游不再唯一。快照中本就有必填的 `route_id`（v1 与 v2 均校验，`service.py:358-361`），而路由三元组不可改名，`route.upstream_id` 永不变化。因此 `resolve_run_model_runtime` 改为 `snapshot.route_id → model_routes → model_upstreams`，不看 `archived_at`，精确命中快照当时那一行上游。由此：

- 在途 Run 不受归档影响，也不受"同名重建"影响，用的始终是快照当时那份凭据；
- 不需要"活跃优先、回退归档"的排序规则，也不需要"归档上游前检查未完成 Run"——两者及其并发竞态一并消失；
- 归档行不可编辑，其凭据在归档后冻结。

本方案成立依赖三条不变量，写入 ADR：

1. **目录行永不删除**，只归档。
2. **`route.upstream_id` 不可变**（三元组不可改名）。
3. **活跃路由的父模型与父上游必然都是活跃的**（由归档与恢复规则共同保证）。

## 不在本轮范围

- 不引入物理删除，也不引入"先归档再彻底删除"的两段式清理。
- 不新增管理员账户或角色，继续使用固定 `X-Model-Admin-Key`。
- 不改动快照格式（仍为 v2），不实现一次 Run 内的跨上游自动 failover。
- 不提供"归档即掐断在途 Run"的能力；需要中止时取消 Run，与现有「下线」语义一致。
- 不改动 `reasoning_outputs` 的能力矩阵与 Adapter 行为。
- 不把 Design 工作台的控制器、合成样本或模拟结果迁入生产代码。

## 归档语义

归档是逐项状态，`archived_at IS NULL` 表示未归档。语义对齐现有外键：`chat_model → route` 为 `ON DELETE CASCADE`，`upstream → route` 为 `ON DELETE RESTRICT`。

| 实体 | 归档前置条件 | 级联 | key |
|---|---|---|---|
| 聊天模型 | 无 | 同一事务内归档其全部未归档路由，`archived_at` 写入与模型**相同的时间值**（Python 侧取一次） | 释放 |
| 模型路由 | 无 | 无 | 释放 |
| 模型上游 | 不存在引用它的未归档路由，否则 409 并列出阻塞路由三元组 | 无 | 释放 |

上游不级联：路由从属于模型，从上游侧级联会静默删掉若干模型的可用路径，应由管理员决定。

恢复规则：

| 恢复对象 | 前置条件（不满足则 409） | 行为 |
|---|---|---|
| 模型 | 不存在同 key 的活跃模型 | 清空 `archived_at`；一并恢复 `archived_at` 等于模型 `archived_at` 的路由（即随它级联归档的那一批），其中上游仍归档的路由保持归档 |
| 路由 | 父模型与父上游均为活跃；不存在同三元组的活跃路由 | 清空 `archived_at` |
| 上游 | 不存在同 key 的活跃上游 | 清空 `archived_at`，不级联 |

恢复模型不会与活跃路由撞部分唯一索引：同 key 活跃模型已被 409 挡住，恢复出的路由 `chat_model_id` 不可能与任何活跃路由相同。此前被单独归档的路由 `archived_at` 与模型不同，不会随模型复活。

补充规则：

- **upsert 只作用于活跃行**：`upsert_chat_model` / `upsert_model_upstream` / `upsert_model_route` 先在**未归档行**中按自然 key 查找，命中则更新，否则插入新行；**不会**复活归档行。"归档 → 用同一个 key 新建"就是一次普通 upsert；恢复必须走显式恢复操作。
- **归档行只读**：所有编辑与启停操作只命中活跃行。
- **归档不等于下线**：`enabled` 语义完全不变，两者独立。归档项即使 `enabled=true` 也不进入可用目录。
- **控制台文案用「归档」而非「删除」**，因为动作可逆；确认框说明可在「已归档」中恢复，并写明级联影响条数。

## 链路与定位

```
① 管理写入   控制台 / CLI → api/v1/model_admin.py (_mutate) → model_catalog/management.py
② 目录读取   capabilities / 创建 Run → service._database_chat_models（过滤归档）→ snapshot() → runs.model_config_snapshot
③ Run 执行   worker/executor.py → service.resolve_run_model_runtime（route_id → upstream，不看归档）
④ 控制台展示 management.catalog_inventory（含归档）→ _catalog_response（archived + ref）→ ModelAdminDashboard
```

归档只在 ② 生效；③ 完全不受归档影响。

| 现象 | 先查 |
|---|---|
| 已归档项仍可选 / 仍出现在 capabilities | ② `_database_chat_models` 过滤 |
| 在途 Run 报上游不存在或用错凭据 | ③ `resolve_run_model_runtime` 的 route_id 解析 |
| 编辑/启停命中归档行，或"改了不生效" | ① `_*_by_key`、`upsert_*` 的过滤 |
| 归档或恢复 409 | ① `management.py` 前置规则（消息写明原因） |
| 目录激活校验因归档项失败 | `_validate_active_routes` 过滤 |
| 归档或新建 500 / IntegrityError | `_mutate` 未把部分唯一索引冲突映射为 409 |
| 控制台同名串位、恢复错对象 | ④ 前端未用 `ref`，或 `_catalog_response` 漏填 ref 字段 |
| 恢复模型后少了路由 | 预期行为：只恢复同批级联且上游活跃的路由 |

## 后端实施

### 数据模型

新增迁移，接在 `20260905_0024_search_indexes` 之后，编号 `_0025`（文件名按 `alembic/versions/` 现有规则）：

| 表 | 变更 | 语义 |
|---|---|---|
| `chat_models` | `archived_at timestamptz NULL` | NULL = 未归档 |
| `model_upstreams` | `archived_at timestamptz NULL` | 同上 |
| `model_routes` | `archived_at timestamptz NULL` | 同上 |

唯一约束替换为只覆盖未归档行的部分唯一索引，名称显式指定，风格对齐既有 `ux_runs_one_active_per_conversation`：

| 原约束 | 新索引 |
|---|---|
| `uq_chat_models_key` | `ux_chat_models_key_active`：`UNIQUE (key) WHERE archived_at IS NULL` |
| `uq_model_upstreams_key` | `ux_model_upstreams_key_active`：`UNIQUE (key) WHERE archived_at IS NULL` |
| `uq_model_routes_model_upstream_remote_model` | `ux_model_routes_model_upstream_remote_model_active`：`UNIQUE (chat_model_id, upstream_id, upstream_model) WHERE archived_at IS NULL` |

三张表量级很小，不为 `archived_at` 单独建索引。

`app/models/model_catalog.py`：三个 ORM 类各加 `archived_at: Mapped[datetime | None]`；`ChatModel.key` / `ModelUpstream.key` 去掉 `unique=True`，`ModelRoute` 去掉 `UniqueConstraint`，改为 `Index(..., unique=True, postgresql_where=text("archived_at IS NULL"))`，确保 metadata 与迁移一致。

downgrade：先查询是否存在同 key（或同三元组）的多行，存在则 `raise` 明确报错，不静默丢数据；否则删部分唯一索引、恢复原约束、再删列。

### 服务层

`app/services/model_catalog/management.py`，沿用既有 `_chat_model_by_key` / `_upstream_by_key` / `_required_text`：

- `archive_chat_model(session, *, key)` —— 级联归档其全部未归档路由，共用同一个 `archived_at`
- `archive_model_upstream(session, *, key)` —— 存在引用它的未归档路由则抛冲突，消息列出三元组
- `archive_model_route(session, *, model_key, upstream_key, upstream_model)` —— 结构照抄 `set_model_route_enabled`（:282-313）
- `restore_archived(session, *, ref)` —— 解析 `ref` 得到表与主键，按「恢复规则」校验后清空 `archived_at`

新增 `ModelCatalogConflictError(ModelCatalogError)`，由 API 层映射为 409。

`app/services/model_catalog/service.py`：`resolve_run_model_runtime` 改为按 `snapshot["route_id"]` join `ModelRoute` → `ModelUpstream` 取上游，不加 `archived_at` 过滤；取到的 `upstream.key` 与 `snapshot["upstream"]` 不一致时抛 `ModelCatalogError`（防御性，key 本不可改）；路由不存在时沿用现有报错。注释写明依赖的两条不变量（行永不删除、`route.upstream_id` 不可变），避免后续改回按 key 查询。

过滤点（均加 `archived_at IS NULL`，缺一不可）：

| 位置 | 变更 | 后果 |
|---|---|---|
| `service.py` `_database_chat_models` | 三表各加 | 归档项从 `/capabilities` 与 Run 创建校验中消失 |
| `management.py` `_validate_active_routes` | 三表各加 | 归档项不参与目录激活校验 |
| `management.py` `_chat_model_by_key` / `_upstream_by_key` | 加 | 编辑与启停只命中活跃行 |
| `upsert_chat_model` / `upsert_model_upstream` 的 key 查询（:164 附近） | 加 | upsert 不命中、不复活归档行；`import_environment_catalog` 随之继承 |
| `upsert_model_route`（:212）与 `set_model_route_enabled` 的三元组查询 | 路由表加 | 路由编辑只命中活跃行 |
| `set_model_upstream_enabled` 启用时遍历路由校验（:274 附近） | 跳过归档路由 | 归档路由不阻塞上游启用 |

`catalog_inventory` 保持返回全部行（含归档），由响应层标注。

### API

`app/api/v1/model_admin.py` 照现有 `PATCH .../enabled`（:132-145、:175-192、:218-236）的写法新增，全部经 `_mutate` 返回完整目录：

| 方法 | 路径 | 请求体 | 作用 |
|---|---|---|---|
| PATCH | `/api/v1/model-admin/models/{model_key}/archived` | `{"archived": true}` | 归档活跃模型（级联其路由） |
| PATCH | `/api/v1/model-admin/upstreams/{upstream_key}/archived` | `{"archived": true}` | 归档活跃上游 |
| PATCH | `/api/v1/model-admin/routes/archived` | 三元组 + `{"archived": true}` | 归档活跃路由 |
| POST | `/api/v1/model-admin/archive/{ref}/restore` | — | 恢复任一归档项 |

归档用 PATCH 而非 DELETE：可逆状态变更，且与 `PATCH .../enabled` 对称。三个归档端点只作用于活跃行，`archived: false` 一律 422 并指向恢复端点。恢复用独立 POST 动作端点（`POST /import-env` 已有先例），按 `ref` 寻址，因为 key 此时已不唯一。

`_mutate` 错误映射：先捕获 `ModelCatalogConflictError` → 409，再捕获 `ModelCatalogError` → 422；部分唯一索引并发冲突抛出的 `IntegrityError` 兜底映射为 409。所有分支均 rollback。

`app/schemas/model_admin.py`：

- 三个 `*Response` 各加 `archived: bool`、`archived_at`（实施时补充：前端据此判断恢复模型会带回哪些路由）与始终存在的 `ref: str`；路由响应另加 `model_ref` 与 `upstream_ref`，使归档路由能挂到正确的（可能同名的）父项下。
- 新增 `SetArchivedRequest`、`SetModelRouteArchivedRequest`（照抄 `EnabledRequest` / `SetModelRouteEnabledRequest`，`archived` 固定为 `true`）。
- `_catalog_response`（:295-342）逐项填充新字段，归档项保留在响应中，由前端决定显示方式。

该响应契约是 Design 候选与前端的共同依赖，后端实施时最先落定。

### CLI

`app/model_admin.py` 新增子命令，每条仍是一个事务，继续承担"页面不可用时的应急入口"职责：

```bash
python -m app.model_admin archive --model deepseek-v4
python -m app.model_admin archive --upstream openrouter
python -m app.model_admin archive --route deepseek-v4 openrouter deepseek/deepseek-chat
python -m app.model_admin restore --ref upstream-4
python -m app.model_admin archived          # 列出归档项及 ref
```

不把归档塞进现有 `set-*` 子命令：`set-*` 是 enable/disable 的二元语义，叠加可逆归档会让"同名 key 作用于哪一行"难以解释。

### 测试

- `tests/api/test_model_admin.py`（沿用 `FakeSession` + monkeypatch `catalog_inventory` + `app.dependency_overrides`）：三个归档端点；恢复端点；冲突错误与 `IntegrityError` 映射为 409 且回滚；归档端点收到 `archived: false` 返回 422；响应含 `ref` / `model_ref` / `upstream_ref`。
- `tests/services/model_catalog/test_model_catalog_service.py`（真实 PG）：
  - 归档项不出现在 `available_chat_models`；
  - 归档上游后，用同一 key 新建活跃上游成功，且归档行仍在；
  - **用旧快照创建 Run → 归档上游 → 同 key 以不同凭据重建 → `resolve_run_model_runtime` 取到的是旧凭据**；必须真的走一次解析并构造 provider；
  - 快照 `upstream` 与 `route_id` 指向的上游 key 不一致时报错；
  - 上游被未归档路由引用时归档返回冲突，并列出三元组；
  - 归档模型级联路由且 `archived_at` 相同；恢复模型只恢复同批路由，单独归档的路由与上游仍归档的路由保持归档；
  - 恢复：同 key 活跃冲突、路由父项已归档、同三元组活跃冲突，三种均返回冲突；
  - upsert 只更新活跃行、不复活归档行；
  - `set_model_upstream_enabled` 启用时跳过归档路由。
- `tests/models/test_metadata.py`：三表 `archived_at` 可空；三个部分唯一索引带 `WHERE archived_at IS NULL`；原唯一约束不再存在。

## 控制台三版布局候选

按 `design/README.md:41-49` 的流程在独立 Design 工程中交付。**硬约束：`current` 分支渲染不得改变**，现有配对基线 `design/output/parity/` 54/54 必须继续通过。

### 三个候选

| proposal ID | 结构 | 解决什么 |
|---|---|---|
| `admin-master-detail` | 保留顶部目录状态卡；下方左列表 + 右详情。左列表顶部 `[模型] [上游]` 分段，行 = 状态点 + label + key + 路由数；右详情 = 头部（状态开关 / 编辑 / 归档）+ 能力 pills + **保留现有路由轨道信息图** + 每条路由的启停/编辑/归档 + 引用该上游的路由清单 | 模型多：垂直增长被收进两个独立滚动区，靠左列表搜索定位 |
| `admin-segmented` | 保留顶部目录状态卡与现有分区骨架；顶部 `[模型] [上游] [路由]` 分段。模型页每行可展开出路由轨道（默认展开一项）；上游页改为列表行；路由页平铺全部路由并按 model 分组 | 路由多：路由页给出跨模型的全局视图 |
| `admin-minimal` | 现有分区、卡片、轨道完全不动，只加搜索框、状态筛选（全部/上线/下线）、`显示已归档`开关、模型卡与路由行/上游卡上的归档按钮、段头 sticky、模型卡可折叠 | 改动最小、风险最低，但只缓解不解决长页 |

三版共同约束（来自 `docs/architecture/frontend.md:112-126`）：

- 路由轨道是业务信息图，不得退化成仅靠表格顺序猜测当前上游；`admin-segmented` 的路由页每行仍带「当前路由 / 目录首选」badge（后端 `selected` 投影）。
- 沿用全局 token 与组件原语，不引入新的私有配色。
- 窄屏必须保留启停、编辑、锁定入口。`admin-master-detail` 窄屏退化为列表 → 详情钻取（带返回），锁定按钮常驻 header。
- 归档与恢复走 `ConfirmDialog`，确认框写明级联影响条数（恢复模型时区分"将恢复"与"因上游仍归档而保持归档"的路由数，由前端依 `ref` 从目录数据计算）。
- 列表、分组与 React key 一律使用 `ref`，不使用 key。

### 文件改动

新增（候选专用，不进 `current`）：

- `design/src/model-admin/proposals/MasterDetailDashboard.tsx`
- `design/src/model-admin/proposals/SegmentedDashboard.tsx`
- `design/src/model-admin/proposals/MinimalShell.tsx`（筛选栏 + 归档区，包住现有 `ModelAdminDashboard`）
- `design/src/model-admin/proposals/archiveActions.tsx`（三版共用的归档/恢复按钮与确认框）

改动：

- `design/src/proposals/registry.ts` —— 追加三个 `status: "draft"` 条目；`applyProposal(id)` 记录当前 proposal ID 并导出读取函数，供结构性分支使用。现有 `example-composer` 的 CSS 变量行为不变。
- `design/src/model-admin/ModelAdminPage.tsx`（design 副本）—— 按当前 proposal 选择 dashboard 组件，`current` 路径渲染结果不变。
- `design/src/model-admin/ModelAdminDashboard.tsx`（design 副本）—— 仅为 `admin-minimal` 追加**可选**归档回调 props，不传时渲染与现在完全一致。
- `design/src/scenarios/registry.ts` —— 追加场景 `admin-dense`（分组「模型管理」）。
- `design/src/scenarios/data.ts` —— 追加 `denseCatalog` 样本（约 10 模型 / 6 上游 / 22 路由，含已归档项，其中至少一组"同 key 活跃 + 归档"并存），按新响应契约带 `ref` 字段。**现有 `catalog` 样本与 `admin` 场景保持不动**，避免动到配对基线。
- `design/src/runtime/results.ts` —— `scene.id === "admin-dense"` 时返回 `denseCatalog`，并给本地 `modelAdminApi` 补归档/恢复回调。

## 前端实施

按 `design/README.md:48`，只迁移产品展示与交互代码。

- `frontend/src/api/modelAdmin.ts`：新增 `archiveModel` / `archiveUpstream` / `archiveRoute` / `restoreArchived(ref)`（与 Design 本地结果同名，配对参考可直接注入）；类型加 `archived: boolean`、`ref: string`，路由加 `model_ref` / `upstream_ref`。沿用 `managementOptions()` 的 `auth: false` + `retryOnUnauthorized: false` 与 `X-Model-Admin-Key`。
- 「已归档」区的恢复与分组必须使用 `ref`，不得回退到 key——同名 key 可能同时对应活跃项与多条归档项。
- `frontend/src/model-admin/ModelAdminPage.tsx`：三个归档 handler、恢复 handler 与成功/失败文案（409 原样呈现后端消息），仍走 `runMutation` 的整目录替换，不做乐观推演。
- `frontend/src/model-admin/ModelAdminDashboard.tsx`：落地选定布局，保留 `selected` 投影、`reasoning_outputs` 由 adapter 矩阵约束、key 与三元组不可改名、API key 不回填等既有不变量。
- `frontend/src/model-admin/ModelAdminEditors.tsx`：预计不变。
- `frontend/src/model-admin/ModelAdminPage.test.tsx`：归档确认、恢复、409 呈现、同名活跃与归档项并存、搜索/筛选行为。
- 真实 Chrome 冒烟 1440×900 与 390×844，沿用 `2026-08-29` handover 对该控制台的验证做法。

## 文档

- 新增 ADR `docs/adr/0014-archive-catalog-rows-instead-of-hard-delete.md`：记录归档替代物理删除、key 通过部分唯一索引释放、管理面按 `ref` 寻址、Run 执行按 `snapshot.route_id` 解析凭据，以及三条不变量（行永不删除、`route.upstream_id` 不可变、活跃路由的父项必然活跃）。
- 回改 `docs/handover/2026-08-29-database-model-catalog.md:39` 与 `docs/architecture/frontend.md:122`，指向新 ADR；同步该 handover 中"Run 按 upstream key 回查凭据"的描述。
- 新增 handover `docs/handover/2026-09-25-model-catalog-archive.md`（含本文「链路与定位」一节），并在 `docs/README.md` 的模型管理行与目录索引中登记。
- `design/approvals/<日期>-<选定 proposal>.json`：需求、sourceCommit、designFingerprint、sceneIds、视口、截图、例外、approvedBy/approvedAt。落选候选从 `proposals/registry.ts` 移除，选定者晋升为 `current`。

## 实施顺序

1. 落定响应契约（`archived` / `ref` / `model_ref` / `upstream_ref` 与四个端点形态），作为 Design 与前端的共同依赖。
2. 在 Design 工程交付三个候选与 `admin-dense` 场景，确认 `current` 配对基线不变。
3. 用户选定布局并填写确认记录。
4. 后端数据层：迁移新增三列、把三个唯一约束换成部分唯一索引，ORM 同步；在空库上跑 `upgrade head` 与 `downgrade -1` → `upgrade head` 往返。
5. 后端服务层：`resolve_run_model_runtime` 改按 `route_id` 解析；`archive_*` / `restore_archived`；全部过滤点；补齐服务层测试。
6. 后端接口：schema、API 四个端点、409 映射、CLI 子命令、API 层测试。
7. 前端：API 客户端、页面 handler、选定布局、测试。
8. 文档与 ADR 回改。
9. 运行全量验证。

步骤 1 最先；步骤 2-3 与步骤 4-6 可并行，布局选择只影响步骤 7。步骤 4 是其余后端步骤的前提；步骤 5 与 6 紧邻，因为 409 映射依赖服务层的冲突类型。

## 可观察验收标准

- `admin-dense` 场景下，`current` 与三个候选可在同尺寸切换比较；`current` 与正式前端的配对结果为 54/54 零差异像素。
- 归档后该项从 `/api/v1/capabilities` 消失，且可通过恢复操作重新出现。
- 归档一个上游后，可以用完全相同的 key 立即新建一条活跃上游，两者并存且互不干扰；新建走普通 upsert，不复活归档行。
- 快照创建于归档之前的 Run，在上游归档且同 key 以不同凭据重建之后，仍解析到原凭据（有自动化测试证明）。
- 归档仍被未归档路由引用的上游返回 409 与阻塞路由清单，而不是 422 或静默成功。
- 归档模型级联归档其路由；恢复模型只恢复同批级联且上游活跃的路由。
- 同 key 已存在活跃行、路由父项已归档、同三元组已有活跃路由时，恢复返回 409，不静默合并。
- 部分唯一索引并发冲突返回 409 而非 500。
- 目录响应逐项带 `archived` 与 `ref`，路由带 `model_ref` / `upstream_ref`；API 从不返回 API key 明文或密文。
- 后端 ruff / mypy / pytest 与前端 lint / typecheck / vitest / build 全部通过。

## 验证命令

```bash
# 后端
uv run ruff check .
uv run mypy app
DATABASE_URL=<isolated-db> uv run alembic upgrade head
DATABASE_URL=<isolated-db> MODEL_CATALOG_TEST_DATABASE_URL=<isolated-db> \
  uv run pytest -q tests/services/model_catalog tests/api/test_model_admin.py tests/models/test_metadata.py
DATABASE_URL=<isolated-db> FILE_MAINTENANCE_TEST_DATABASE_URL=<isolated-db> \
  uv run pytest -q --ignore=tests/services/agents/test_prompts.py
docker compose -f compose.yml config -q && docker compose -f compose.prod.yml config -q
git diff --check

# 前端
cd frontend && pnpm run lint && pnpm run typecheck && pnpm exec vitest run && pnpm run build

# Design（两个浏览器套件共用 5182 端口，顺序执行）
pnpm --dir design check:boundaries
pnpm --dir design lint && pnpm --dir design typecheck && pnpm --dir design test --run
pnpm --dir design test:visual
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend exec tsc -p tsconfig.design-reference.json
pnpm --dir design test:parity
pnpm --dir design catalog
```

`tests/services/agents/test_prompts.py` 的既有失败（内置 prompt 使用产品名 `Piko`，断言仍为 `iChat`）与本方案无关，沿用 `2026-08-29` handover 记录的 `--ignore` 处理，本次不修改品牌选择。

## 上线与回滚

迁移新增三列且全部可空，旧代码读取时忽略新列；部分唯一索引在还没有归档行之前与旧约束完全等价，可安全 expand。归档是纯数据库状态变更，提交后立即对新 Run 生效，不需要重启 API 或 Worker。`resolve_run_model_runtime` 的 route_id 解析对既有快照（v1/v2 均含 `route_id`）直接生效，无需回填。

回滚应用时先回滚代码，数据库保持 expand 状态。两点注意：

- 已归档的行在旧代码下会重新出现在目录中（旧代码不识别 `archived_at`），`enabled` 语义未变；需要时先用新代码恢复所需条目、或将归档项下线，再回滚。
- 若某个 key 同时存在归档行与活跃行（即已经用过"归档后同名重建"），旧代码的按 key 查询（`_*_by_key` 与旧版 `resolve_run_model_runtime`）结果不确定，可能编辑到归档行、或让在途 Run 取到另一份凭据。回滚前先归档活跃行、恢复归档行，使每个 key 只剩一行。

不建议 downgrade 删除列：除了会丢掉归档状态，恢复原唯一约束在存在同 key 多行时必然失败（downgrade 脚本会先检测并报错）。
