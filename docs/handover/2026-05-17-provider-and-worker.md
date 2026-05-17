# 2026-05-17 Provider 和 Worker 交接

## 本次完成

按 `docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md` 的实现计划（`docs/superpowers/plans/2026-05-17-provider-and-worker.md`），完成了 provider 抽象层、context builder、run 生命周期状态机、worker claim/lease/heartbeat/recovery，以及 DeepSeek HTTP adapter 的端到端实现。

后续 review 中发现并修复了三处 provider/worker 风险：

- DeepSeek 请求未显式传递 `DEEPSEEK_THINKING_ENABLED`，会导致 thinking 配置形同虚设。
- Worker 取消依赖 provider 继续产出 chunk，provider stream 阻塞时无法及时取消。
- Run terminal 状态转换无 guard，存在 recovery、cancel、provider finish 互相覆盖状态或重复写 terminal event 的竞态。

以下是按模块的完整总结：

### 1. Provider 领域类型和 ABC（Task 1-3）

新增 `app/providers/` 包：

- `app/providers/types.py`：定义 `ProviderMessage`、`TextDelta`、`Finish`、`ProviderChunk`、`ProviderError`、`ProviderRole`，以及 `Provider` ABC（`name` 属性 + `stream()` async iterator）。
- `app/providers/registry.py`：`resolve_provider(name, *, settings)` 按名解析 provider 实例，未知名称抛出 `UnknownProviderError`。当前只注册 `"deepseek"`。
- `app/providers/resolve_provider` 从 `__init__.py` 导出。

测试夹具 `tests/providers/fake.py`：
- `FakeProvider`：按脚本 yield `TextDelta | Finish` chunk，`RaiseError` 抛出 `ProviderError`，`Sleep` 等待。
- 用于后续所有 worker 测试，替代真实 LLM 调用。

### 2. Context Builder（Task 4）

新增 `app/context/builder.py`：

- `build_context(session, *, run_id, system_prompt, budget_chars)`：
  - 加载 run 及其目标 user message。
  - 查询同 conversation 下 `archived_at IS NULL` 且 `position <= target.position` 的所有 messages，按 position 升序。
  - 标准化 role 为 `ProviderRole` 字面量。
  - 预算截断：当历史消息总字符数超过 `budget_chars` 时，从最早的消息开始丢弃，始终保留至少一条历史消息（即目标 user message 永远不会被截断）。
  - 在结果前插入 `system` 消息。system prompt 不占预算。
- `LookupError`：run 或目标 message 不存在时。

### 3. Run 生命周期状态机（Task 5-6）

新增 `app/services/runs/lifecycle.py`，与已有的 `app/services/runs/service.py` 并行（lifecycle 负责写路径，service 负责读路径）：

- `claim_next_queued_run(session, *, worker_id, lease_seconds)`：`SELECT ... FOR UPDATE SKIP LOCKED` 出队最早的 `queued` run，设置 `status='started'`、`started_at`、`lease_owner`、`lease_expires_at`、`heartbeat_at`，写入 `run_started` event。返回 run id 或 None。
- `mark_run_streaming(session, *, run_id)`：仅允许 `started → streaming`，首次调用时设置 `first_streamed_at`，返回是否实际完成转换。
- `mark_run_succeeded(session, *, run_id, usage, provider_request_id)`：仅允许 `started|streaming → succeeded`，写入 `run_succeeded` event，设置 `completed_at`、`usage_metadata`、`provider_request_id`，清除 lease，返回是否实际完成转换。
- `mark_run_failed(session, *, run_id, code, message)`：仅允许 `started|streaming|cancelling → failed`，写入 `run_failed` event，设置 `failed_at`、`error_code`、`error_message`，清除 lease，返回是否实际完成转换。
- `mark_run_cancelled(session, *, run_id)`：仅允许 `queued|started|streaming|cancelling → cancelled`，写入 `run_cancelled` event，设置 `cancelled_at`，清除 lease，返回是否实际完成转换。
- `renew_lease(session, *, run_id, lease_seconds)`：仅对 `started|streaming|cancelling` 且仍有 `lease_owner` 的 run 延长 `lease_expires_at` 并更新 `heartbeat_at`，返回是否实际续租。
- `is_cancelling(session, *, run_id)`：检查 status 是否为 `cancelling`。
- `run_has_text_delta(session, *, run_id)`：检查是否存在 `text_delta` event。
- `recover_expired_runs(session)`：扫描 status IN `('started','streaming','cancelling')` 且 `lease_expires_at < now()` 的 run，使用 `SKIP LOCKED`，调用 `mark_run_failed(code='lease_expired')`；如果目标 run 已被其他路径转成 terminal，则 no-op，不重复写 terminal event。

状态转换函数内部使用 `SELECT ... FOR UPDATE` 锁定 run，并在写状态和 terminal event 前检查当前 status。这样可以避免取消、recovery、provider finish 同时到达时互相覆盖 terminal 状态。

所有新增函数从 `app/services/runs/__init__.py` 导出，与原有 service 层导出共存。

### 4. Materialize Assistant Message（Task 7）

在 `app/services/conversations/service.py` 中新增：

- `materialize_assistant_message(session, *, run_id, content)`：
  - 加载 run，获取下一个 position，创建 `role='assistant'` 的 Message（带 `run_id` 链接和 `conversation_id`）。
  - 更新 `conversation.updated_at`。
  - run 不存在时抛出 `LookupError`。

### 5. Worker Executor（Task 8-10）

新增 `app/worker/` 包：

`app/worker/executor.py`：
- `ProviderResolver` Protocol：`(name, *, settings) -> Provider`。
- `execute_run(*, session_factory, run_id, worker_id, settings, resolve_provider)`：
  1. 加载 run 并调用 `build_context` 构建 provider messages。
  2. 通过 `resolve_provider(provider_name)` 实例化 provider。
  3. 启动 `_heartbeat_loop` 后台 task，每 `worker_heartbeat_interval_seconds` 续租并检测 `cancelling` 状态。
  4. `_run_provider_stream_until_done_or_cancelled` 同时等待 provider stream task 和 `cancel_event`：
     - provider stream 先完成时，返回正常 stream outcome。
     - `cancel_event` 先完成且 provider stream 仍阻塞时，主动 cancel provider stream task，然后进入取消收尾。
  5. `_run_provider_stream` 迭代 provider chunk：
     - `TextDelta` → 首个 delta 时 `mark_run_streaming` → `append_run_event` → 累积文本。
     - `Finish` → `mark_run_succeeded`；仅当状态转换实际成功时才 `materialize_assistant_message`。
     - 在 chunk 间和 delta 持久化后检查 `cancel_event`，若被设置则走取消收尾。
     - `ProviderError` → 决定是否重试（见下）。
  6. **重试策略**：最多 2 次尝试；仅在首次 delta 持久化前失败时重试一次；已有 `text_delta` event 时不再重试（`run_has_text_delta` 查询）。
  7. 意外的 executor 异常（如 DB 连接失败）传播到 worker main loop，由 recovery loop 处理 lease 过期。

取消行为更新：
- heartbeat 发现 run 已进入 `cancelling` 后设置 `cancel_event`，但不主动停止续租；heartbeat task 由 `execute_run` 的 `finally` 统一取消。
- 如果 provider stream 卡住且不再产出 chunk，`cancel_event` 仍会触发 `_run_provider_stream_until_done_or_cancelled` 取消 stream task。
- 如果取消、失败恢复或 provider finish 发生竞态，lifecycle 的状态 guard 会保证最多只有一个 terminal transition 真正生效。

### 6. Worker Main Loop & Recovery Scheduler（Task 11）

`app/worker/main.py`：
- `run_worker_loop(*, session_factory, settings, worker_id, resolve_provider, stop_event, recovery_interval_seconds)`：
  - 启动独立的 `_recovery_loop` background task，按 `recovery_interval_seconds` 调度 `recover_expired_runs`。
  - 主循环：`claim_next_queued_run` → `execute_run` → repeat，poll 间隔为 `worker_poll_interval_seconds`。
  - 通过 `asyncio.Event`（`stop_event`）控制优雅退出。
- `run_worker_from_settings()`：从 settings 和 session factory 创建并运行 worker loop，注册 `SIGINT`/`SIGTERM` handler。
- `build_worker_id()`：`hostname-pid-uuid[:8]`。
- `app/worker/__main__.py`：`python -m app.worker` 入口点。

### 7. DeepSeek Provider（Task 12-13）

`app/providers/deepseek_parser.py`：
- `parse_sse_line(line)`：纯函数，解析 DeepSeek SSE `data:` 行。
  - `data: [DONE]` → `None`。
  - `choices[0].delta.content` → `TextDelta`。
  - `choices[0].finish_reason` 非 null → `Finish`（含 `usage`）。
  - 无效 JSON → `ProviderError("deepseek_invalid_json")`。

`app/providers/deepseek.py`（替换 Task 3 的占位实现）：
- `DeepSeekProvider(*, settings, transport=None)`：
  - 使用 `httpx.AsyncClient` 的 `stream("POST", "/chat/completions")` 调用 DeepSeek OpenAI-compatible API。
  - 流式处理 SSE 行，通过 `parse_sse_line` 解析。
  - 从 `x-request-id` response header 提取 `provider_request_id`，注入 `Finish` chunk。
  - 请求 payload 按 `settings.deepseek_thinking_enabled` 显式传递 `thinking: {"type": "enabled"|"disabled"}`。
  - HTTP ≥400：`ProviderError("deepseek_http_error")`，body 截断至 500 字符。
  - 传输/超时异常：`ProviderError("deepseek_transport_error")`。
  - `transport` 参数支持 `httpx.MockTransport` 注入，用于测试。

### 8. Compose（Task 14）

`compose.yml`：`worker` service 的 command 从 sleep placeholder 替换为 `["python", "-m", "app.worker"]`。

## 文件摘要

新增文件：
- `app/providers/__init__.py`、`types.py`、`registry.py`、`deepseek_parser.py`
- `app/providers/deepseek.py`（已替换初始占位实现）
- `app/context/__init__.py`、`builder.py`
- `app/services/runs/lifecycle.py`
- `app/worker/__init__.py`、`executor.py`、`main.py`、`__main__.py`

修改文件：
- `app/providers/__init__.py`（多次扩展导出）
- `app/services/runs/__init__.py`（扩展导出，保持原有导出不变）
- `app/services/conversations/service.py`（追加 `materialize_assistant_message`）
- `app/services/conversations/__init__.py`（追加导出）
- `app/providers/deepseek.py`（DeepSeek HTTP adapter；review 后补上 `thinking` payload）
- `app/worker/executor.py`（review 后补上阻塞 stream 主动取消、状态转换返回值处理）
- `app/services/runs/lifecycle.py`（review 后补上状态转换 guard 和 terminal 幂等）
- `app/core/config.py`（`worker_poll_interval_seconds` 和 `worker_heartbeat_interval_seconds` 类型改为 `float`）
- `compose.yml`（worker command）

测试文件：
- `tests/providers/__init__.py`、`test_types.py`、`test_registry.py`、`test_deepseek_parser.py`、`test_deepseek_adapter.py`
- `tests/providers/fake.py`、`test_fake.py`
- `tests/context/__init__.py`、`test_builder.py`
- `tests/services/runs/test_lifecycle.py`
- `tests/services/conversations/test_materialize.py`
- `tests/worker/__init__.py`、`test_executor.py`、`test_main.py`
- `tests/__init__.py`（为满足 mypy strict 的包标记）

## 配置新增

这些配置项在 `.env.example` 和 `app/core/config.py` 中已存在（MVP 设计阶段预留）；本次实现正式使用：

| 变量 | 用途 |
|---|---|
| `DEFAULT_SYSTEM_PROMPT` | context builder 的全局 system prompt |
| `RUN_LEASE_SECONDS` | worker 租约时长 |
| `WORKER_POLL_INTERVAL_SECONDS` | worker 空队列时的轮询间隔 |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | 续租和取消检测间隔 |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_BASE_URL` | DeepSeek API base URL |
| `DEEPSEEK_MODEL` | 模型名称 |
| `DEEPSEEK_THINKING_ENABLED` | DeepSeek thinking/reasoning 开关；provider 会显式映射为请求 payload 中的 `thinking.type` |

类型变更：`worker_poll_interval_seconds` 和 `worker_heartbeat_interval_seconds` 从 `int` 改为 `float`（支持子秒级测试）。

## 数据库和迁移

本次未创建新迁移。`runs` 表的 lease 字段（`lease_owner`、`lease_expires_at`、`heartbeat_at`、`started_at`、`first_streamed_at`、`completed_at`、`failed_at`、`cancelled_at`、`error_code`、`error_message`、`usage_metadata`、`provider_request_id`）和 `run_events` 表在初始迁移 `20260516_0001_create_core_tables.py` 中已存在。

`messages` 表有一个 `archived_at` 列（regenerate 场景使用），以及 `run_id` FK。本次 `materialize_assistant_message` 写入 `run_id`。

## 关键设计决策

1. **Provider 抽象：** 业务逻辑（worker executor）只依赖 `Provider` ABC，不感知 DeepSeek-specific 类。registry 是平凡的 name→instance 映射，无 DI 框架。
2. **Queue 使用 Postgres：** `FOR UPDATE SKIP LOCKED` 加 `LIMIT 1 ORDER BY` 实现无锁抢占。无 Redis/Celery 依赖。
3. **重试策略：** Provider 失败时，仅在**首个 text delta 持久化前**重试一次。通过 `run_has_text_delta` 查询而非内存标志（两次尝试之间 session 不同）来防止误判。
4. **取消机制：** API 将 run 置为 `cancelling`（API 不在本次范围）。Worker heartbeat task 每次轮询检查状态并设置 `cancel_event`。executor 同时等待 provider stream task 和 cancel task，因此即使 provider stream 阻塞、没有新 chunk，取消也可以主动 cancel stream task。
5. **状态转换幂等：** `mark_run_streaming`、`mark_run_succeeded`、`mark_run_failed`、`mark_run_cancelled` 和 `renew_lease` 都在行锁内检查当前状态并返回 `bool`。调用方只能在返回 `True` 时继续执行依赖该状态的副作用，例如物化 assistant message。
6. **Recovery：** 独立 async task 在 Worker 进程内运行，使用 `SKIP LOCKED` 批量处理 lease 过期的 active run。不恢复 HTTP stream，不拼接 partial output 到新调用（spec 明确禁止）：只将 run 标记为 `failed`。如果 run 已由其他路径进入 terminal，recovery no-op。
7. **Assistant message 物化：** 仅在 `mark_run_succeeded` 实际完成 `succeeded` transition 后由 worker 写入。失败、取消的 run 不物化 message，partial `text_delta` events 保留。
8. **DeepSeek thinking 配置：** `DEEPSEEK_THINKING_ENABLED` 是 provider-level 开关，adapter 会显式传入 DeepSeek 请求，避免依赖上游默认值。

## 验证命令

```bash
uv run pytest -v
uv run ruff check .
uv run mypy .
docker compose -f compose.yml config
```

本次验证结果：
- 130 passed，1 warning（deprecation 警告来自第三方库，非本项目代码）。
- ruff：All checks passed。
- mypy：Success: no issues found in 81 source files。
- compose config：OK。

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
10. Run event 写入、递增 seq 和持久化 replay 查询。
11. Run state API（当前 draft 恢复）。
12. SSE replay/tail endpoint，terminal event 后自动结束。
13. Provider 域类型和 ABC。
14. Provider registry + DeepSeek provider。
15. Fake provider 测试夹具。
16. Context builder（system prompt + 归档过滤 + 预算截断）。
17. Run 生命周期状态机（claim、guarded transitions、lease、expired recovery）。
18. Assistant message 物化（仅在 run succeeded 时）。
19. Worker executor（stream→events→materialize，retry-once，heartbeat+cancel detection，阻塞 stream 主动取消）。
20. Worker main loop + recovery scheduler。
21. DeepSeek SSE parser + HTTP streaming adapter + thinking 配置映射。
22. Compose worker service 接线。

仍未完成：
1. Run cancellation API（`POST /api/v1/runs/{run_id}/cancel`）。
2. Regenerate 归档规则（`POST /api/v1/messages/{message_id}/regenerate`）。
3. 手动 DeepSeek smoke 验证（用真实凭据）。
4. 前端应用。
5. 邮件发送、邮箱验证。
6. 密码重置。
7. 计费、额度和支付。
8. Redis、Celery、LangChain、LangGraph、LiteLLM、OpenTelemetry、Prometheus。
9. Conversation branch。
10. 原生 EventSource 支持和 `Last-Event-ID`。
11. Model/provider 管理 API。

## 接下来的开发任务

建议按此顺序推进：

1. Run cancellation API（`POST /api/v1/runs/{run_id}/cancel`）—— API 设 `cancelling`，worker 已有完整响应。
2. Regenerate——从任意 user message 归档后续消息并创建新 queued run。
3. 手动 DeepSeek smoke——用真实凭据端到端验证。
4. 前端 MVP。

## 注意事项

- 文档使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 后续所有 `/api/v1/*` JSON 成功响应继续使用 `SuccessResponse`。
- `/healthz`、`/readyz` 和 SSE 不使用成功响应 envelope。
- 受保护 API 继续使用 `get_current_user()`。
- HTTP 连接只观察 run；不拥有 run 生命周期（API→worker 通过 `queued`/`cancelling` status 通信）。
- Worker lifecycle 写路径必须通过 guarded transition 函数；不要绕过 service 直接改 terminal status 或直接写 terminal event。
- `mark_run_succeeded` 返回 `True` 之后才能物化 assistant message；返回 `False` 表示 run 已被取消、失败或处在其他不允许成功的状态。
- heartbeat 检测到 `cancelling` 后只设置 `cancel_event`，不提前退出；`execute_run` 结束时统一取消 heartbeat task。
- `append_run_event` 不校验 user ownership（未来 worker 也会使用）；HTTP API 层通过 `get_owned_visible_run()` 校验。
- `claim_next_queued_run` 内部 `append_run_event` 存在冗余的 `FOR UPDATE` 锁（同一事务内），perf 优化空间留待后续清理。
