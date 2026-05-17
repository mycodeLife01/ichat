# 2026-05-17 Run Cancellation 交接

## 本次完成

- 实现 Runs Service 取消写路径：
  - `cancel_owned_run(session, *, user, run_id)`：用 `Run -> Conversation -> User` 校验当前用户 ownership，conversation 软删除返回 `404 Run not found`。
  - 用 `SELECT ... FOR UPDATE` 锁定 runs 行，避免与 worker heartbeat、stream finalize 竞争。
  - `queued` run：直接置为 `cancelled`，写 `cancelled_at`、`completed_at`，清空 `lease_owner`、`lease_expires_at`，并追加 `run_cancelled` terminal event。
  - `started`、`streaming` run：只置为 `cancelling`，不写 terminal event；终态由 worker heartbeat 观察到 `cancelling` 后关闭 provider stream 并写入。
  - `cancelling`、`succeeded`、`failed`、`cancelled` run：幂等返回 `CommandStatusResponse(status="ok")`，不写状态、不写 event。
  - 取消状态分组以三个常量声明：`CANCEL_DIRECT_STATUSES`、`CANCEL_REQUEST_STATUSES`、`CANCEL_IDEMPOTENT_STATUSES`。
- 实现 Run Cancellation API：
  - `POST /api/v1/runs/{run_id}/cancel`：thin handler，复用 `get_current_user()`，调用 `cancel_owned_run()` 后由 handler 提交事务，返回 `SuccessResponse[CommandStatusResponse]`。
  - 未认证返回标准 `401 Authentication required`；跨用户和软删除 conversation 返回 `404 Run not found`。
- 补强 Worker 取消优先级（在原计划之外，避免 worker 与用户取消竞态时把已被用户取消的 run 标成 failed）：
  - Stream 失败路径：在终态写入前调用 `_mark_failed_or_cancelled_if_cancelling()`，若数据库已是 `cancelling` 则写 `cancelled`，否则才写 `failed`。
  - Context-build 失败路径：同样在 rollback 后通过 `_mark_failed_or_cancelled_if_cancelling()` 决定终态，保证 build 阶段中途被取消时不会被错写为 `context_build_error`。

## 文件摘要

- `app/services/runs/service.py`：新增 `cancel_owned_run()` 和三个取消状态常量。
- `app/services/runs/__init__.py`：导出 `cancel_owned_run`。
- `app/api/v1/runs.py`：新增 `POST /{run_id}/cancel` route 和对应 imports。
- `app/worker/executor.py`：`_mark_failed_or_cancelled_if_cancelling()` 帮助函数 + 在 stream 失败和 context-build 失败路径上替换原先的 `mark_run_failed()` 直接调用。
- `tests/services/runs/test_run_service.py`：补充 9 个 service 测试，覆盖 queued、started/streaming、所有 terminal、cancelling 幂等、跨用户、软删除 conversation。
- `tests/api/test_runs.py`：补充 5 个 API 测试，覆盖未认证、queued、streaming、terminal 幂等、跨用户。
- `tests/worker/test_executor.py`：新增 `test_execute_run_marks_cancelled_when_context_build_fails_after_db_cancelling`，覆盖 context-build 中途被取消的场景；既有的 stream 取消优先级测试沿用。
- `docs/superpowers/specs/2026-05-17-run-cancellation-design.md`：本功能设计文档。
- `docs/superpowers/plans/2026-05-17-run-cancellation.md`：本功能实现计划。

## API 行为说明

- `POST /api/v1/runs/{run_id}/cancel`：
  - 必须携带 `Authorization: Bearer <access_token>`；未认证返回：
  ```json
  { "detail": "Authentication required" }
  ```
  - 当前用户不拥有该 run、或 conversation 已软删除：返回 `404`：
  ```json
  { "detail": "Run not found" }
  ```
  - 成功响应（所有非 404 情况）统一为：
  ```json
  {
    "data": { "status": "ok" }
  }
  ```
  - 不返回 run 当前 status；前端如需展示终态请走 `/state` 或 `/events`。
  - 任意状态下重复调用都幂等：第二次及之后调用不会改写 status，也不会追加 event。
- 与 `/state` 和 `/events` 的关系：
  - 取消后 `/state` 的 `status` 字段会立即反映 `cancelled` 或 `cancelling`；`terminal_event` 在 worker 写入 `run_cancelled` 之前可能仍为 `null`。
  - `/events` SSE 在 worker 写入 terminal event 时自动结束。
- 状态转换汇总：

| 取消前 status | 取消后 status | 是否写 `run_cancelled` event | `cancelled_at` / `completed_at` |
|---|---|---|---|
| `queued` | `cancelled` | 是（service 直接写） | 立即设置 |
| `started` | `cancelling` | 否（worker 后续写入） | worker 决定 |
| `streaming` | `cancelling` | 否（worker 后续写入） | worker 决定 |
| `cancelling` | `cancelling` | 不重复写 | 维持 |
| `succeeded` / `failed` / `cancelled` | 不变 | 不重复写 | 维持 |

## 数据库和迁移

- 本次未创建新迁移。
- 复用现有 `runs.status`、`runs.cancelled_at`、`runs.completed_at`、`runs.lease_owner`、`runs.lease_expires_at` 字段。
- 复用 `run_events` 表，`type = "run_cancelled"` 作为 terminal event；`payload` 为 `{}`。
- queued run 直接写终态时清空 lease 字段，避免 worker recovery scheduler 误把已取消的 run 当作过期 run 重新捞起。

## 取消语义与并发

- 用户视角：单一入口 `POST /{run_id}/cancel`，无论 run 处于哪个状态都得到一致的 `{"status": "ok"}`。
- queued 与 worker claim 的竞态：`cancel_owned_run()` 用 `with_for_update()` 锁定 runs 行，与 `claim_next_queued_run()` 互斥；若 worker 在取消请求拿到锁之前已经把 status 推到 `started`，则 cancel 走 `CANCEL_REQUEST_STATUSES` 分支，正确置为 `cancelling`。
- started/streaming 阶段不在 API handler 内取消 provider stream：worker heartbeat（参见 `app/worker/executor.py`）周期性读取 `runs.status`，发现 `cancelling` 后触发 `cancel_event`，关闭 provider stream，并由 worker 写 `run_cancelled` terminal event。
- worker 终态优先级：通过 `_mark_failed_or_cancelled_if_cancelling()` 统一处理 stream 失败和 context-build 失败两条路径——只要数据库已被推到 `cancelling`，最终一律写 `cancelled`，绝不写 `failed`。这样可以避免“用户取消 + 同一时刻 provider 抛错”导致状态机被推到 `failed` 的歧义。
- cancelling/terminal 幂等：service 仅返回成功响应，不重写 status，也不再写 event；保证前端任何时刻重试都安全。

## 实现注意事项

- API handler 只负责认证、调用 service、`session.commit()`、构造 `SuccessResponse`，不做状态判断；所有取消语义集中在 `cancel_owned_run()`。
- `cancel_owned_run()` 在 `queued` 分支内 `await session.flush()` 后再调用 `append_run_event()`，保证 `runs` 行先写入数据库再分配 `seq`。
- `CommandStatusResponse` 直接复用 `app/schemas/auth.py` 中已存在的 schema，避免新增等价类型。
- worker 端 stream 失败与 context-build 失败现在共享同一终态决策函数；新增 helper 后 `app/worker/executor.py` 中再无 `mark_run_failed()` 的直接调用进入主流程。
- 不调用 provider API，不持有 HTTP stream 生命周期，不改 SSE 协议或 `/state` 字段；纯数据库状态写入。
- service 与 API 的所有测试均为黑盒行为测试（断言 status、cancelled_at/completed_at、events 序列、HTTP 响应体）；未引入 worker 端 mock。

## 本次刻意未做

- 未新增 Alembic migration。
- 未实现批量取消（cancel 所有 conversation 下未完成 run）。
- 未在 cancel API 响应里返回当前 run status；前端如需展示请改走 `/state`。
- 未实现 SSE `Last-Event-ID`。
- 未对取消加 rate limit。
- 未触达 provider/worker 取消细节本身（heartbeat 和 cancel_event 在前序 worker 模块已实现）。

## 验证命令

```bash
uv run pytest tests/services/runs/test_run_service.py tests/services/runs/test_lifecycle.py tests/api/test_runs.py tests/worker/test_executor.py -v
uv run pytest -v
uv run ruff check .
uv run mypy .
```

本次验证结果：

- 取消相关 + worker 回归：52 passed（包含 `test_execute_run_marks_cancelled_when_status_flips_during_stream`、`test_execute_run_cancels_blocked_provider_stream_promptly`、`test_execute_run_marks_cancelled_when_context_build_fails_after_db_cancelling`）。
- 全量 `uv run pytest`：147 passed。
- `uv run ruff check .`：All checks passed!
- `uv run mypy .`：Success: no issues found in 81 source files。

验证依赖：

- 本地 PostgreSQL 需要可用。
- 本次使用 Docker Compose 启动本地 `postgres` 服务。
- Run 测试默认使用：

```text
postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat
```

## 当前项目进度

已完成：

1. 项目骨架、模块边界、Docker Compose 和基础依赖。
2. FastAPI app factory、配置、日志、错误类型、健康检查和数据库 session 基础设施。
3. Alembic 基础环境和首个业务迁移。
4. MVP 核心 ORM models。
5. 统一成功响应 envelope。
6. 用户注册、登录、refresh token 轮换、登出和当前用户依赖。
7. Conversation 创建、列表、详情、重命名和软删除。
8. 提交 user message 并创建 queued run。
9. 每个 conversation 一个 active run 的 service/API 覆盖。
10. Run event 写入、递增 `seq` 和持久化 replay 查询。
11. Run state API（当前 draft 恢复）。
12. SSE replay/tail endpoint，terminal event 后自动结束。
13. Provider interface、DeepSeek streaming adapter、fake provider。
14. Worker claim、lease、heartbeat、provider stream 执行 loop 和 recovery scheduler。
15. Run cancellation API、service 取消写路径、worker 取消优先级保证。

仍未完成：

1. Regenerate 归档规则。
2. 真实 DeepSeek smoke 验证。
3. 批量取消、cancel rate limit。
4. SSE `Last-Event-ID`。

## 接下来的开发任务

建议下一步：

1. 接入前端取消按钮，串通 `POST /cancel` → `/state` 重新拉取 → `/events` 终态结束流程。
2. 增加 regenerate 入口：对已 terminal 的 run 触发 archive 并创建新 run。
3. 跑一次真实 DeepSeek 端到端 smoke：登录 → 创建 conversation → 发消息 → 中途取消 → 校验 `cancelled` 终态。
4. 视需要补充批量取消和 cancel rate limit。

## Git 状态

- 本模块相关提交：

```text
daff88e chore: ignore .obsidian workspace metadata
efdcdfa docs: archive run cancellation plan and design
a8ea786 docs: add subagent model policy to conventions
3ab48f0 fix: prefer cancellation over context-build failure
2dcd139 fix: prefer cancellation over worker failure
05bb3c7 fix: tighten run cancellation coverage
180b084 feat: add run cancellation api
1840740 feat: add run cancellation service
```

- 写入本交接文档前，工作区为 clean。
- 写入本交接文档后，当前新增 `docs/handover/2026-05-17-run-cancellation.md` 待提交。

## 注意事项

- 文档使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 受保护 API 继续使用 `get_current_user()`。
- `cancel_owned_run()` 是取消语义的唯一入口；任何未来需要触发取消的代码路径（例如管理后台、清理脚本、超时回收）必须复用它，不要绕过去直接写 `runs.status`。
- worker 端写终态请继续走 `_mark_failed_or_cancelled_if_cancelling()`，不要直接调用 `mark_run_failed()`，否则可能把已被用户取消的 run 错写为 failed。
- 任何新增的 run 状态都必须明确分类到 `CANCEL_DIRECT_STATUSES`、`CANCEL_REQUEST_STATUSES` 或 `CANCEL_IDEMPOTENT_STATUSES` 之一，否则 `cancel_owned_run()` 会落到 fallthrough 分支并默默返回成功。
