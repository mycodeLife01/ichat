# 2026-05-19 Worker 并发与 LISTEN/NOTIFY 交接

## 本次完成

按 `C:\Users\jackey\.claude\plans\text-delta-worker-worker-listen-notify-idempotent-beaver.md` 的方案，完成了从"单 worker 串行处理一个 run"到"多 worker × 单 worker 内并发 × NOTIFY 驱动"的并发改造。改造目标是为多用户场景做准备，让 LLM 流式响应可以并行处理，且 worker↔DB / SSE↔DB 之间的轮询全部换成 PG 原生 LISTEN/NOTIFY 推送（保留兜底 poll）。

六个阶段（按风险递增）：

1. Settings 字段扩展 + DB 连接池调大。
2. text_delta 持久化批量化（时间窗口 50ms 或字符阈值 256 触发 flush）。
3. 单 worker 内基于 `asyncio.Semaphore` 的并发执行（默认 8 路）。
4. claim 端 LISTEN/NOTIFY（worker 不再轮询 DB）。
5. SSE 端 LISTEN/NOTIFY（进程级 `RunEventSubscriptionManager`，单 LISTEN 连接 fan-out 到多 SSE handler）。
6. `compose.prod.yml` + `compose.yml` 多 worker 副本，Postgres `max_connections` 上调。

## 关键设计要点

### 1. Delta 批量化（`app/worker/executor.py`）

之前每个 `TextDelta` 一次 `commit`，DeepSeek 单流就有 30-60 TPS 小事务。改造后通过本地 buffer 累积：

- `text_parts` 累积全文（finish 时用于物化 assistant message）；`pending` 累积尚未持久化的字符。
- Flush 触发条件（任一满足即 flush）：
  - 距离窗口起点 ≥ 50ms（`worker_delta_batch_window_ms`）。
  - 累计字符 ≥ 256（`worker_delta_batch_max_chars`）。
  - 收到 `Finish` 之前。
  - 收到 `ProviderError`、cancel、流意外结束之前（保留 partial 进度）。
- 首次 flush 时调用 `mark_run_streaming`，保留原有"首 delta 切状态"语义。
- 由于 SSE 端原本就是 200ms（现 5s fallback）粒度，对前端 UX 无可感影响。

**关键陷阱：** 最初实现用 `asyncio.wait_for(stream_iter.__anext__(), timeout=...)` 做时间窗口 flush，但 `wait_for` 超时会 cancel 内层 task，进而 cancel provider stream 的协程，**毒化 generator** 导致后续 chunk 全部丢失（`FakeProvider` 在 `Sleep` 中被 cancel 后 generator 关闭，下一次 `__anext__` 直接返回 sentinel，run 被错判为 "no_finish"）。

修复方式：**producer/consumer 模式**。后台 `_producer` task 用 `async for` 把 chunk 推入 `asyncio.Queue`，主循环 `wait_for(queue.get(), timeout=...)`。超时只 cancel `queue.get()`，对底层 stream 协程无影响。`ProviderError` 由 producer 转成队列里的一个 item 传出。

### 2. 单 worker 并发（`app/worker/main.py`）

`run_worker_loop` 改造：

- `asyncio.Semaphore(settings.worker_max_inflight_runs)` 限制并发上限（默认 8）。
- `inflight: set[asyncio.Task]` 跟踪在飞 run，每个 task 完成时回调释放 semaphore + 从 set 移除。
- 主循环模式：`await semaphore.acquire()` → claim → 拿到则 `create_task(execute_run)`，没拿到则释放 semaphore + 等 NOTIFY/超时。
- 优雅退出：`stop_event` 触发后 `await asyncio.gather(*inflight)`，不主动 cancel —— heartbeat 持续续租，避免被 recovery loop 误抢。worst case shutdown 等单个 LLM 响应时长（几十秒），可接受。
- recovery loop 保持独立 task 不变。

### 3. claim 端 LISTEN/NOTIFY

**Producer**：`app/services/conversations/service.py::submit_user_message` 在 run flush 之后追加：

```python
await session.execute(
    text("SELECT pg_notify('runs_queued', :payload)"),
    {"payload": str(run.id)},
)
```

`pg_notify` 在事务 commit 时才派发，匹配 run 行可见性。

**Consumer**：新文件 `app/worker/notify_listener.py::RunQueuedListener`。启动时用 `asyncpg.connect` 单开一条**独立连接**（不走 SQLAlchemy pool，否则连接会被还回去），`add_listener('runs_queued', callback)`，回调 set `asyncio.Event`。Worker 通过 `_wait_for_signal_or_stop` 同时等 stop_event / NOTIFY / fallback timeout。

worker_poll_interval_seconds 默认值从 2s 提升到 30s（仅作 fallback，正常情况下 NOTIFY 在毫秒内唤醒）。

### 4. SSE 端 LISTEN/NOTIFY

**Producer**：`app/services/runs/service.py::append_run_event` 末尾追加 `pg_notify('run_events', :run_id)`。

**Consumer**：新文件 `app/services/run_events/subscription.py::RunEventSubscriptionManager`：

- 进程级单例，FastAPI lifespan 启动/关闭。
- 持有**一条** asyncpg 专用连接 LISTEN `run_events`。
- 内部 `dict[run_id, set[asyncio.Event]]` 维护订阅关系。
- 收到 NOTIFY → 解析 run_id payload → 找对应 set → 全部 `set()`。

这是本次最关键的架构决策：**绝不允许每个 SSE 连接持有自己的 LISTEN 连接**。否则 N 个并发 SSE = N 条 PG 连接持续占用，连接数轻松爆。一个 manager × 一条 LISTEN × 无限订阅者才能 scale。

SSE handler（`app/api/v1/runs.py::stream_run_events_route`）：

- 进入时 `wake = manager.subscribe(run_id)`。
- 主循环：先 `list_run_events_after` 拉一次；没新事件就 `wait_for(wake.wait(), timeout=fallback)`，再 `wake.clear()` 进下一轮。
- terminal event 出现立即退出。
- `finally` 必须 `unsubscribe`，否则订阅表会泄漏。

常量 `SSE_POLL_INTERVAL_SECONDS = 0.2` 移除，改为读取 `settings.sse_fallback_interval_seconds`（默认 5.0）。

**断线自动重连不在本次范围**。LISTEN 连接断开后会丢失通知，由 fallback poll 兜底退化到旧行为。

### 5. DB 连接池

`app/db/session.py::create_engine` 之前只设了 `pool_pre_ping=True`，pool 默认 5+10 严重不足。改为参数化：

- 默认 `pool_size=20, max_overflow=20`（单 worker 8 并发 × 峰值 2 连接 + 余量 ≈ 24）。
- 加 `pool_timeout` 参数（默认 30s）。
- 提供 `_factory_from_settings(settings)` 工厂从 Settings 读取所有 pool 参数。

### 6. Compose & Postgres

`compose.prod.yml`：
- worker `deploy.replicas: 2`。
- postgres `command: postgres -c max_connections=300`。计算：2 worker × 40 + API × 40 + LISTEN 专用 ×3 + 余量。

`compose.yml`（本地开发）：
- worker `deploy.replicas: 2`。
- postgres 同样 `max_connections=300`。
- **新增 `migrate` service**：one-shot `python -m alembic upgrade head`，api/worker 都 `depends_on: migrate: service_completed_successfully`。这样 `docker compose up` 一条命令即可拉起带 schema 的 PG + 1 API + 2 worker。

## 文件改动清单

### 新增

| 文件 | 用途 |
|---|---|
| `app/worker/notify_listener.py` | `RunQueuedListener`：worker claim 端的 LISTEN 客户端 |
| `app/services/run_events/__init__.py` | 空包 |
| `app/services/run_events/subscription.py` | `RunEventSubscriptionManager`：API 进程级 LISTEN fan-out |
| `tests/services/run_events/__init__.py` | 空包 |
| `tests/services/run_events/test_subscription.py` | 订阅管理器内存层单测（不依赖 PG） |
| `tests/worker/test_executor_batching.py` | delta 批量化测试（merge、char threshold、time window、error-flush） |
| `tests/worker/test_concurrency.py` | semaphore 并发与上限测试 |

### 修改

| 文件 | 变更 |
|---|---|
| `app/core/config.py` | 新增 `worker_max_inflight_runs`、`worker_delta_batch_window_ms`、`worker_delta_batch_max_chars`、`db_pool_size`、`db_max_overflow`、`db_pool_timeout_seconds`、`sse_fallback_interval_seconds`，均带默认值 |
| `app/db/session.py` | `create_engine` / `create_session_factory` 加 pool_size / max_overflow / pool_timeout 参数；新增 `_factory_from_settings` |
| `app/worker/executor.py` | `_run_provider_stream` 重写为 producer/consumer 模式 + 批量 flush；`execute_run` 透传 batch 参数 |
| `app/worker/main.py` | semaphore + inflight 集合 + shutdown drain；接入 `RunQueuedListener`；新增 `_wait_for_signal_or_stop` |
| `app/services/conversations/service.py` | `submit_user_message` 末尾 `pg_notify('runs_queued', run_id)` |
| `app/services/runs/service.py` | `append_run_event` 末尾 `pg_notify('run_events', run_id)` |
| `app/api/v1/runs.py` | SSE handler 接入 `RunEventSubscriptionManager`；常量替换为 `sse_fallback_interval_seconds`；新增 `_get_subscription_manager` 依赖 |
| `app/main.py` | FastAPI lifespan 启停 `RunEventSubscriptionManager`，挂到 `app.state.run_event_subscriptions` |
| `compose.yml` | 新增 `migrate` 服务；worker 加 `replicas: 2`；postgres 加 `max_connections=300` |
| `compose.prod.yml` | worker 加 `replicas: 2`；postgres 加 `max_connections=300` |
| `pyproject.toml` | 加 `[[tool.mypy.overrides]] module = "asyncpg.*" ignore_missing_imports = true`（asyncpg 无 stubs） |
| `.env.example` | 同步新增 env key；`WORKER_POLL_INTERVAL_SECONDS=30` 改默认值（仅 fallback） |
| `tests/api/test_runs.py` | `app` fixture 手动启动/停止 `RunEventSubscriptionManager`（ASGITransport 不触发 lifespan） |
| `tests/worker/test_executor.py` | 一处事件序列断言更新：两个连续 TextDelta 现在合并为一条 text_delta event |

## 配置新增

`.env` / `.env.example` / `app/core/config.py`：

| 变量 | 默认 | 用途 |
|---|---|---|
| `WORKER_MAX_INFLIGHT_RUNS` | 8 | 单 worker 进程内 LLM 流并发上限 |
| `WORKER_DELTA_BATCH_WINDOW_MS` | 50 | text_delta flush 时间窗口（毫秒） |
| `WORKER_DELTA_BATCH_MAX_CHARS` | 256 | text_delta flush 字符阈值 |
| `DB_POOL_SIZE` | 20 | SQLAlchemy pool_size |
| `DB_MAX_OVERFLOW` | 20 | SQLAlchemy max_overflow |
| `DB_POOL_TIMEOUT_SECONDS` | 30 | pool 获取连接超时（秒） |
| `SSE_FALLBACK_INTERVAL_SECONDS` | 5.0 | NOTIFY 未到达时 SSE 兜底重新拉 DB 的间隔 |
| `WORKER_POLL_INTERVAL_SECONDS` | 30（旧默认 2） | NOTIFY 未到达时 worker claim 的兜底间隔 |

## 关键设计决策

1. **批量化不影响前端 UX**：SSE 现已 5s fallback 但有 NOTIFY 在 ms 级唤醒，端到端延迟比改造前的 200ms 轮询更低。worker 50ms flush 比 SSE 5s fallback 短得多，不会"便秘"。
2. **producer/consumer 而非 `wait_for(anext())`**：直接对 stream iterator 加 `wait_for` 会在 timeout 时 cancel 内层 task，毒化 generator。改造过程中被这个 bug 卡住，4 个测试集体红，最后 refactor 队列模式解决。
3. **LISTEN 连接独立于 SQLAlchemy pool**：必须用 `asyncpg.connect` 直接开连接，长期持有，不能借池里的连接（会被还回去）。worker 一个，API 一个。
4. **SSE manager 进程级单例**：N 个 SSE 连接 fan-out 到一条 LISTEN 连接。在 ASGITransport 测试场景下 lifespan 不会触发，测试 fixture 需要手动调 `manager.start()`/`stop()`。
5. **shutdown 等待而非 cancel**：在飞的 run 让它跑完，避免被 recovery loop 误抢导致重复执行。
6. **fallback poll 保留**：LISTEN 不持久，断线即丢通知。fallback 兜底使系统永远退化不停摆。生产稳定后再加自动重连。
7. **seq 分配未改**：仍是 `MAX(seq)+1`。安全前提是"每个 run 同一时刻只有一条主协程写事件"——本次并发是 run-level（不同 run 并行），不会有同 run_id 内并发写。如果未来引入"同一 run 内并发事件写"必须先重构 seq。

## 验证命令与结果

```bash
uv run ruff check app tests
uv run mypy app
DATABASE_URL=postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat \
  JWT_SECRET=... [全套 env] \
  uv run pytest tests/ --tb=short
docker compose config
```

本次验证结果（含真实 PG 容器）：

- ruff：All checks passed。
- mypy：Success: no issues found in 47 source files。
- pytest：**160 passed, 1 warning in 20.08s**。其中：
  - 4 个新批量化测试。
  - 2 个新 worker 并发测试（3 并发 < 1.5s；cap=1 串行 ≥ 0.8s）。
  - 7 个新 `RunEventSubscriptionManager` 单测。
  - 14 个 SSE API 测试（含 tail 测试，端到端验证 pg_notify → wake → DB query）。
  - 原有 worker / executor / cancel 测试全部保留并通过。
- `docker compose config`：4 services（postgres / migrate / api / worker），合并配置含 `replicas: 2` 和 `max_connections=300`。

## 注意事项

- **测试环境必须有真实 PG**。本次测试套件大量依赖 `pg_notify` 真实派发，conftest fixture 直接 `create_async_engine` 连库；CI 已配置 postgres service，本地需 `docker run` 一个 postgres 或起 compose 后再 `pytest`。
- **`compose.yml` 本地开发需要 `.env`**。新增 `migrate` 服务后 `docker compose up` 流程：postgres 健康 → migrate 执行迁移 → api + 2× worker 启动。如未配置 `.env`，compose 会在变量解析阶段就失败。
- **多 worker × NOTIFY**：N 个 worker 同时 LISTEN，PG 向每个 listener 投递。N 次 wake-up 但只有一个能 claim（SKIP LOCKED 仲裁），其余空跑一次 claim。开销可忽略。
- **`append_run_event` 现在每次调用都会派发 pg_notify**。事务回滚则不派发（pg_notify 在 commit 才生效）。SSE 端不会收到回滚事件的误唤醒。
- **`materialize_assistant_message` 不变**。仅在 `mark_run_succeeded` 实际成功时由 worker 写入。批量化只影响 text_delta 的拆分粒度，最终 assistant message 的 content 仍是全文。
- **producer/consumer 队列没有上限**：极端长流的内存占用 = chunk 数 × chunk 大小。DeepSeek 单 token chunk 很小，几千 chunk 也只有几百 KB，可接受。
- **`RunEventSubscriptionManager._subscribers` 中 dict/set 操作未加锁**：asyncio 单线程模型下 `_on_notify` 与 `subscribe`/`unsubscribe` 不可能并发执行（前者是 asyncpg 同步回调，后者是同步方法），无需加锁。

## 当前进度更新

新增已完成：

23. text_delta 批量持久化（时间窗 + 字符阈值双触发，producer/consumer 模式抵抗 wait_for 取消污染）。
24. 单 worker `asyncio.Semaphore` 并发与上限控制；shutdown drain 不打断 inflight。
25. claim 端 PG LISTEN/NOTIFY（`runs_queued` channel + 独立 asyncpg 连接 + fallback poll）。
26. SSE 端 PG LISTEN/NOTIFY（`run_events` channel + 进程级 `RunEventSubscriptionManager` + lifespan 接线）。
27. DB 连接池参数化 + Postgres `max_connections` 上调。
28. `compose.prod.yml` worker `replicas: 2`；`compose.yml` 同步加 `replicas: 2` 与 `migrate` one-shot 服务。

仍未完成（不变）：

1. LISTEN 连接断线自动重连（依赖 fallback poll，生产观察后再加）。
2. claim 批量化（一次 `SKIP LOCKED LIMIT N` 拉多条），目前每次只拉一条。
3. seq 分配换 SEQUENCE / 原子化（当前 `MAX(seq)+1` 在并发不同 run 间无竞态，但同 run 内并发写会冲突，本次没引入该场景）。
4. 监控指标（inflight count、queue depth、池利用率、单 run 端到端耗时）。生产化时再加。
5. Regenerate / 邮件 / 计费等业务模块（与本次并发改造无关，按原路线推进）。

## 关联文档

- 实现方案：`C:\Users\jackey\.claude\plans\text-delta-worker-worker-listen-notify-idempotent-beaver.md`
- 模块边界：`docs/architecture/module-boundaries.md`（未受本次改造影响）
- Provider/Worker 基础：`docs/handover/2026-05-17-provider-and-worker.md`
- Run events / SSE 基础：`docs/handover/2026-05-17-run-events-sse-replay.md`
