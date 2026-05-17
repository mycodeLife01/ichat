# 2026-05-17 Run Events 和 SSE Replay 交接

## 本次完成

- 实现 Run Event Schemas：
  - `RunEventResponse`：SSE event data 和 run state 中嵌套 terminal event 的序列化 schema。
  - `RunStateResponse`：页面恢复所需的 `draft_text`、`latest_seq`、`status` 和 `terminal_event`。
  - `RunEventType`：`run_started`、`text_delta`、`run_succeeded`、`run_failed`、`run_cancelled`。
  - `RunStatus`：`queued`、`started`、`streaming`、`succeeded`、`failed`、`cancelling`、`cancelled`。
- 实现 Runs Service：
  - `get_owned_visible_run()`：通过 `run -> conversation -> user` 校验当前用户 ownership，conversation 软删除后返回 `404 Run not found`。
  - `append_run_event()`：使用 `SELECT ... FOR UPDATE` 锁定 runs 行后分配单调递增 `seq`，保证并发 writer 串行分配。
  - `list_run_events_after()`：查询 `seq > after_seq` 的已持久化 events（不含 ownership 校验，供 SSE poll loop 使用）。
  - `list_owned_run_events_after()`：含 ownership 校验的 event 查询。
  - `get_owned_run_state()`：遍历所有 events 拼接 `draft_text`，定位 terminal event。
  - `run_has_terminal_event()`：检查 run 是否已有 `run_succeeded`、`run_failed` 或 `run_cancelled` event。
- 实现 Run API：
  - `GET /api/v1/runs/{run_id}/state`：返回 `SuccessResponse[RunStateResponse]`，`terminal_event` 显式输出 `null` 而非省略字段。
  - `GET /api/v1/runs/{run_id}/events?after_seq=0`：`StreamingResponse`，先 replay `seq > after_seq` 的已持久化 events，再 poll tail 新 events，terminal event 后自动结束。`after_seq` 已越过 terminal event 时立即返回空 stream。
- 在 `app/main.py` 挂载 runs router。
- 所有 run API 复用 `get_current_user()` 认证依赖。
- `/events` SSE 成功响应不使用 `SuccessResponse`；`/state` JSON 成功响应继续使用 `{"data": ...}` envelope。

## 文件摘要

- `app/schemas/runs.py`：run event SSE data、run state JSON response 和 run event/status literal 类型。
- `app/services/runs/__init__.py`：导出 runs service public API。
- `app/services/runs/service.py`：ownership 校验、event seq 分配、event 查询、terminal 判断和 draft state 聚合。
- `app/api/v1/runs.py`：`/state` JSON endpoint 和 `/events` SSE endpoint，保持 thin handler。
- `app/main.py`：挂载 runs router。
- `tests/schemas/test_run_schemas.py`（41 行）：schema 序列化和 terminal event 嵌套测试。
- `tests/services/runs/test_run_service.py`（247 行）：seq 分配、after_seq 查询、state 聚合、ownership 和软删除隔离测试。
- `tests/api/test_runs.py`（382 行）：认证、跨用户访问、`after_seq` 校验、persisted replay、tail 和 terminal 结束行为测试。
- `docs/superpowers/plans/2026-05-17-run-events-sse-replay.md`：本模块实现计划。

## API 行为说明

- `GET /api/v1/runs/{run_id}/state`：
  - 校验当前用户 ownership，conversation 软删除后返回 `404`。
  - 响应格式：
  ```json
  {
    "data": {
      "run_id": 1,
      "status": "streaming",
      "latest_seq": 3,
      "draft_text": "Hello world",
      "terminal_event": null
    }
  }
  ```
  - `terminal_event` 存在时为 `RunEventResponse` 对象，不存在时为 `null`。
  - `draft_text` 只拼接 `text_delta.payload.text` 为字符串的内容。
  - `status` 来自 `runs.status`，不在 service 层做 status 推断。
- `GET /api/v1/runs/{run_id}/events?after_seq=0`：
  - 进入 stream 前校验 ownership 和软删除，跨用户或已删除 conversation 的 run 返回标准 JSON `404`。
  - 成功响应为 `text/event-stream`，每条 event 格式：
  ```
  id: 2
  event: text_delta
  data: {"seq":2,"type":"text_delta","payload":{"text":"Hello"},"created_at":"2026-05-17T12:00:00Z"}

  ```
  - Replay phase：查询 `seq > after_seq` 的已持久化 events，按 seq 升序逐个 yield。
  - Tail phase：每 `0.2s` poll 新 events，有则 yield。
  - 每次 poll 后执行 `session.rollback()` 释放事务，避免在两次 poll 之间持有数据库锁。
  - Terminal 结束：yield 到 terminal event 或检测到 terminal event 已存在时立即 `return`。
  - `after_seq >= terminal_seq` 时直接返回空 stream，避免挂住。
  - `after_seq` 通过 `Query(ge=0)` 校验，负值返回 `422`。

## 数据库和迁移

- 本次未创建新迁移。
- 现有 `20260516_0001_create_core_tables.py` 已包含所需表：
  - `runs`
  - `run_events`
- `run_events` 继续作为本次功能的事实源。
- `append_run_event()` 使用 `with_for_update()` 锁定 runs 行，再从 `run_events` 查询 `max(seq)`，保证并发写入时 seq 串行递增且无空洞。
- `append_run_event()` 不校验 user ownership（未来 worker 也会使用）；HTTP API 层通过 `get_owned_visible_run()` 或 `get_owned_run_state()` 校验。

## 用户重放体验设计

页面重新打开时，前端不应从空白开始逐个播放历史 delta。推荐流程：

1. 前端确定需要恢复的 `run_id`。
2. 调用 `GET /api/v1/runs/{run_id}/state`。
3. 立即渲染 `draft_text`。
4. 如果 `terminal_event` 为 `null`，打开 `GET /api/v1/runs/{run_id}/events?after_seq=<latest_seq>`。
5. 后续只 append 新收到的 `text_delta`。

无漏 event 竞态：`/state` 返回后、SSE 连接前 worker 又写入了新 event 时，SSE endpoint 会先 replay `seq > latest_seq` 的已存储 events，再 tail 更新。

## 实现注意事项

- `append_run_event()` 的 `SELECT ... FOR UPDATE` 锁定 runs 行，保证并发 writer 串行化，但当前 worker 未实现，实际并发写入场景尚未覆盖。
- `/events` 的 poll loop 内每次查询前执行 `session.rollback()`，释放前一次 poll 持有的数据库事务。这是 FastAPI 异步 session 依赖的正常用法：同一个 session 在 poll loop 内用于多次读取，每次读取后需要 rollback 以获取最新数据。
- `get_owned_run_state()` 在构造 `RunStateResponse` 时对 `run.status` 使用 `cast(RunStatus, run.status)`，因为数据库存储为 `str`，但 `RunStatus` 是 literal type。
- terminal event 判定只依赖 `run_events.type`（`run_succeeded`、`run_failed`、`run_cancelled`），不直接依赖 `runs.status`。
- 如果 `runs.status` 已 terminal 但没有 terminal event，SSE endpoint 不会擅自合成 event；后续 worker/状态机任务负责保证 terminal event 写入。
- conversation 软删除后 run API 返回 `404 Run not found`，数据库中的 events 不删除。
- SSE endpoint 未实现 `Last-Event-ID`。

## 本次刻意未做

- 未实现 provider interface、DeepSeek adapter 或 fake provider。
- 未启动 worker，未实现 worker claim、lease、heartbeat 或 recovery。
- 未实现 run cancellation API。
- 未实现 regenerate。
- 未物化 assistant message。
- 未实现 `Last-Event-ID`。
- 未新增 Alembic migration。

## 验证命令

```bash
uv run pytest tests/schemas/test_run_schemas.py tests/services/runs/test_run_service.py tests/api/test_runs.py -v
uv run pytest tests/api/test_app.py tests/api/test_auth.py tests/api/test_conversations.py tests/api/test_runs.py -v
uv run pytest
uv run ruff check .
uv run mypy .
```

本次验证结果：

- Run focused tests：16 passed。
- API focused tests：27 passed。
- 最终 `uv run pytest`：82 passed。
- `uv run ruff check .`：All checks passed。
- `uv run mypy .`：Success: no issues found in 54 source files。

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

仍未完成：

1. Run cancellation。
2. Regenerate 归档规则。
3. Context builder。
4. Provider interface、DeepSeek adapter 和 fake provider stream。
5. Worker claim、lease、heartbeat、provider stream 执行和 recovery。
6. 真实 DeepSeek smoke 验证。

## 接下来的开发任务

建议下一步实现 provider interface 和 worker：

1. 定义 provider interface，实现 fake provider stream。
2. 实现 worker claim、lease、heartbeat 和 provider stream 执行 loop。
3. 在 worker 中调用 `append_run_event()` 写入 `text_delta` 和 terminal event。
4. 用 fake provider 测试完整 run 生命周期（queued → streaming → succeeded）。
5. 实现 DeepSeek adapter。
6. 实现 run cancellation。

## Git 状态

- 本模块相关提交：

```text
d7a907a fix: type run state status
200303e test: avoid run service test module collision
bc2f461 test: assert terminal sse event data
d270a18 test: harden run event sse tailing
7b68282 test: cover run event sse tailing
52a1577 fix: release sse poll transaction before sleep
17b49d3 feat: add run event sse replay
0d7a12b docs: keep run state terminal event explicit
5624ac5 docs: clarify run state null terminal event
0b75584 feat: add run state api
2677e39 feat: add run event service
e2b9a3f feat: add run event schemas
```

- 写入本交接文档前，工作区为 clean。
- 写入本交接文档后，当前新增 `docs/handover/2026-05-17-run-events-sse-replay.md` 待提交。

## 注意事项

- 文档使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 后续所有 `/api/v1/*` JSON 成功响应继续使用 `SuccessResponse`。
- `/healthz`、`/readyz` 和 SSE 不使用成功响应 envelope。
- 受保护 API 继续使用 `get_current_user()`。
- provider 和 worker 不应被 API handler 直接调用；HTTP 连接只观察 run，不拥有 run 生命周期。
- `append_run_event()` 未来由 worker 使用，不校验 user ownership；API 层必须通过 `get_owned_visible_run()` 校验。
