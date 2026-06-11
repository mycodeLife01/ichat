# 架构总览

> 本文是 iChat 后端**运行时**架构的总结。模块/目录职责见 [`module-boundaries.md`](module-boundaries.md)；本文聚焦各服务如何协同、数据如何流动、并发与失败如何处理。状态截至 2026-06-11。

## 服务拓扑

前端是独立 React SPA（`frontend/`，Vite + TypeScript + Tailwind v4），部署于 Cloudflare Pages（`chat.feslia.com`），经 CORS 跨域调用后端 API（`https://feslia.com/api/v1`）——后端不托管任何静态文件。前端实现细节见 `docs/handover/frontend/` 系列交接文档。

后端三个进程组成一个最小可用栈，共享一个 Postgres：

```
                                    HTTPS:8443 (Cloudflare Origin Cert)
                                          │
                                  ┌───────▼────────┐
                                  │ Nginx (prod)   │  反向代理，SSE 友好
                                  └───────┬────────┘
                                          │ HTTP
                          ┌───────────────┼───────────────┐
                          │                               │
                ┌─────────▼─────────┐         ┌───────────▼───────────┐
                │ API (uvicorn)     │         │ Worker × N (replicas) │
                │ FastAPI           │         │ python -m app.worker  │
                │                   │         │                       │
                │ Routes:           │         │ 单进程内 asyncio       │
                │ • auth            │         │ Semaphore 并发 N runs │
                │ • conversations   │         │ (默认 8)              │
                │ • runs (SSE)      │         │                       │
                │                   │         │ heartbeat / lease     │
                │ RunEventSubMgr    │         │ RunQueuedListener     │
                │ (LISTEN run_events)│        │ (LISTEN runs_queued)  │
                └─────────┬─────────┘         └───────────┬───────────┘
                          │                               │
                          │  asyncpg pool + LISTEN conn   │
                          └──────────────┬────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │ PostgreSQL 16       │
                              │ max_connections=300 │
                              │                     │
                              │ tables + pg_notify  │
                              └─────────────────────┘
```

API 处理 HTTP 请求和 SSE 推送，**不调用 LLM**。Worker 是独立进程，负责所有 provider 流式调用和持久化。两者唯一的通信媒介是 Postgres——数据通过表，唤醒通过 `pg_notify`。

## 端到端数据流（用户发一条消息）

```
1. 用户 POST /api/v1/conversations/{id}/messages
   ├─ API (submit_user_message)
   │  ├─ 插入 message (role=user)
   │  ├─ 插入 run (status=queued)
   │  └─ pg_notify('runs_queued', run_id)         ← 事务 commit 时派发
   │
   ▼
2. Worker.RunQueuedListener 收到 NOTIFY → set asyncio.Event
   ├─ 主循环醒来 → semaphore.acquire()
   ├─ claim_next_queued_run() with FOR UPDATE SKIP LOCKED
   │  └─ status: queued → started, lease 续上, 写 run_started event
   │
   ├─ asyncio.create_task(execute_run(run_id))   ← 不阻塞主循环
   │
   └─ 主循环继续 acquire/claim 下一个 run（最多 N 路并发）

   execute_run:
   ├─ build_context() 拼装 prompt
   ├─ heartbeat task 启动（每 N 秒续 lease + 查 cancelling）
   ├─ producer task 启动（async for chunk in provider.stream() → queue.put）
   │
   ├─ 主循环 wait_for(queue.get(), timeout=batch_window):
   │  ├─ TextDelta → 缓存到 pending；阈值满即 flush
   │  │  └─ flush: mark_run_streaming（首次） + append_run_event(text_delta)
   │  │            └─ pg_notify('run_events', run_id)                ← SSE 唤醒
   │  ├─ TimeoutError → 时间窗到，flush pending
   │  └─ Finish → flush pending → mark_run_succeeded + materialize_assistant_message
   │            └─ append_run_event(run_succeeded) → pg_notify('run_events', ...)

   ▼
3. 同时：客户端 GET /api/v1/runs/{id}/events 建立 SSE
   ├─ API 通过 RunEventSubscriptionManager.subscribe(run_id) 拿到 asyncio.Event
   ├─ 循环：list_run_events_after(cursor) → yield 给客户端
   │       └─ 若无新事件，wait_for(event.wait(), timeout=fallback)
   │            └─ pg_notify 到达时 manager 把对应 run_id 的所有 Event set()
   ├─ 收到 terminal event (run_succeeded/failed/cancelled) → return
   └─ finally: unsubscribe
```

## Run 状态机

```
                      cancel API (queued)
            ┌─────────────────────────────┐
            │                             ▼
   created  │   ┌──── recovery ────────┐  cancelled (terminal)
            │   │  (lease 过期)         │  ▲
            ▼   │                       │  │
         queued ├──claim──► started ────┼──┤ cancel API
                            │           │  │ (started/streaming → 经 cancelling）
                            ▼           │  │
         首 flush ────► streaming ──────┴──┤
                            │              │
                            ├── finish ──► succeeded (terminal)
                            └── error ───► failed    (terminal)
                                            ▲
                                            │ 多次重试耗尽
                                            │ 或 partial delta 后失败
```

转换函数（`app/services/runs/lifecycle.py`）全部用 `SELECT … FOR UPDATE` 加行锁 + 当前 status guard，返回 `bool` 表示是否真的发生转换：取消/recovery/finish 三方竞态时，**只有一个**会赢。

## 持久化模型

| 表 | 关键列 | 角色 |
|---|---|---|
| `users` | id, email, password_hash, email_verified | 账号 |
| `refresh_tokens` | jti, user_id, revoked_at, family_id | 旋转式 refresh token |
| `conversations` | id, user_id, deleted_at, updated_at | 对话容器（软删除） |
| `messages` | id, conversation_id, run_id, role, content, position, archived_at | 历史消息；position 单调递增 |
| `runs` | id, conversation_id, status, lease_owner, lease_expires_at, heartbeat_at | LLM 流的状态机 + 队列 |
| `run_events` | id, run_id, seq, type, payload | 流式事件 append-only，SSE replay 依据 |

**关键约束**：

- `runs.ux_runs_one_active_per_conversation`：partial unique index on `(conversation_id)` where status in `('queued','started','streaming','cancelling')`。同一对话同时只能有一个活跃 run。
- `run_events.uq_run_events_run_seq`：`(run_id, seq)` unique。seq 当前用 `MAX(seq)+1` 分配（同 run 内串行写，无竞态）。
- `runs.ix_runs_lease_expires_at`：recovery loop 扫描过期 lease 的索引。

**Postgres 既是状态存储也是任务队列**。`FOR UPDATE SKIP LOCKED` 实现无锁 claim；`pg_notify` 实现推送。无 Redis / Celery / 其他中间件。

## 并发模型

### 单 worker 内（asyncio）

```
worker 主协程:
  Semaphore(N=8) ── acquire ──► claim ──► spawn task ──► repeat
                                          │
                                          ▼ N 个 in-flight task 并行：
                                          ┌────────────┬────────────┬─...
                                          │ execute_run│ execute_run│
                                          │  heartbeat │  heartbeat │
                                          │  producer  │  producer  │
                                          │  consumer  │  consumer  │
                                          └────────────┴────────────┴─...

  每个 task 完成 → release semaphore → 主协程可以 claim 下一个
```

每个 in-flight run 同时持有约 2 个 DB 连接峰值（heartbeat session + delta flush session，都短促），加上 1 个独立的 LISTEN 连接（worker 进程级共享）。

### 多 worker（compose replicas）

```
Postgres queue (runs WHERE status='queued')
       │
       │ pg_notify('runs_queued')  ┌──► worker-A (8 in-flight max)
       ├─────────────────────────►├──► worker-B (8 in-flight max)
       │                          └──► worker-C ...
       │
       │ FOR UPDATE SKIP LOCKED 仲裁：N 个 worker 同时收到 NOTIFY，
       │ 各自尝试 claim，只有一个能锁到目标行，其余空跑回继续等。
```

集群上限 = `worker_replicas × worker_max_inflight_runs`。生产默认 2 × 8 = 16 路并发流。

### SSE 多订阅者

```
       N 个 SSE 连接（每客户端 1 个）
              │ subscribe(run_id) → asyncio.Event
              ▼
       RunEventSubscriptionManager (进程级单例)
              │
              │ dict[run_id, set[Event]]
              │
              ▼
       一条 asyncpg 连接 LISTEN run_events
              │
              ▼
       Postgres
```

**关键**：所有 SSE 共享**一条**底层 LISTEN 连接。否则 1000 个并发 SSE = 1000 条 PG 连接，连接数会爆。

## LISTEN/NOTIFY channels

| Channel | Producer | Payload | Consumer | 用途 |
|---|---|---|---|---|
| `runs_queued` | `submit_user_message` 在 `pg_notify('runs_queued', run.id)` | `str(run_id)`（仅作 hint，不可信） | 每个 worker 进程的 `RunQueuedListener` | 唤醒 claim loop 立即出队 |
| `run_events` | `append_run_event` 末尾 `pg_notify('run_events', run.id)` | `str(run_id)` | 每个 API 进程的 `RunEventSubscriptionManager` | 唤醒等待该 run 的所有 SSE handler |

两个 channel 都遵循同样的不变量：

- NOTIFY 在事务 **commit** 时派发，与行可见性一致。
- 通知**不持久**——连接断开期间错过的通知不会重发。所以两端都有 fallback poll 兜底：worker 默认 30s，SSE 默认 5s。最坏退化到纯轮询。
- payload 不可信——consumer 仍要查库（DB 是真相）。

## 取消、Lease 与故障恢复

### 取消

用户 `POST /runs/{id}/cancel`：

| 当前状态 | 行为 |
|---|---|
| `queued` | 直接 `cancelled` + run_cancelled event |
| `started` / `streaming` | 设为 `cancelling`（不立刻杀），等 worker 检测 |
| `cancelling` / 已 terminal | 幂等 no-op |

Worker heartbeat（每 N 秒）查 `cancelling` 状态，set `cancel_event`，executor 的 `_run_provider_stream_until_done_or_cancelled` 同时 await stream + cancel_event，先到先停。Provider stream 卡住不出 chunk 也能强 cancel。

### Lease & recovery

每个被 claim 的 run 有 `lease_owner` 和 `lease_expires_at`。worker 每 N 秒续租。worker 进程崩了或 lease 没续上：

- 同一 worker 进程内独立的 `_recovery_loop` 每 15s 扫描 `lease_expires_at < now()` 的 active run。
- 调 `mark_run_failed(code='lease_expired')`。
- 状态 guard 保证：如果同时 cancel / 其他 worker 抢到、写 terminal，recovery 会 no-op，不会重复写 terminal event。

## 配置（关键容量参数）

| 变量 | 默认 | 影响 |
|---|---|---|
| `WORKER_MAX_INFLIGHT_RUNS` | 8 | 单 worker 进程内 LLM 流并发上限 |
| `WORKER_DELTA_BATCH_WINDOW_MS` | 50 | text_delta flush 时间窗 |
| `WORKER_DELTA_BATCH_MAX_CHARS` | 256 | text_delta flush 字符阈值 |
| `WORKER_POLL_INTERVAL_SECONDS` | 30 | claim 兜底间隔（NOTIFY 失效时退化到这个） |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | 10 | 续 lease + 查 cancelling 的频率 |
| `RUN_LEASE_SECONDS` | 60 | 单个 run 的 lease 时长 |
| `SSE_FALLBACK_INTERVAL_SECONDS` | 5.0 | SSE 兜底重新拉 DB 的间隔 |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | 20 / 20 | 单进程 SQLAlchemy 池容量 |
| Postgres `max_connections` | 300（compose 覆盖） | 容纳 2 worker × 40 + API × 40 + LISTEN × 3 + 余量 |

容量推导：单 run 峰值 ~2 个池连接；8 路并发 ≈ 16，留 2× 余量到 40。pool_size + max_overflow ≥ max_inflight × 2。

## 数据流不变量

跨模块的几条**绝不能违反**的规则：

1. **API 不调用 provider**。路由→service→DB。LLM 调用只发生在 worker 进程。
2. **Worker 不通过 HTTP 向 API 推送**。所有状态通信走 DB（status 字段 + run_events）。
3. **run 状态转换必须经 lifecycle 函数**（带 guard 和 lock）。不允许直接 `run.status = ...` 写 terminal。
4. **terminal event 与 status 一致**。`mark_run_succeeded`/`failed`/`cancelled` 在同事务里既改 status 又写 event，要么都成功要么都不发生。
5. **partial delta 在 terminal 前必须 flush**。批量 buffer 里残留的 pending text 在 `ProviderError`、cancel、Finish 前都会被强制 flush，否则会丢字。
6. **每个 conversation 同时只有一个 active run**。partial unique index 在 DB 层强制；service 层 `ensure_no_active_run` 在创建前再校验一次，给 user 友好的 409。
7. **assistant message 只在 `mark_run_succeeded` 返回 `True` 后物化**。失败/取消的 run 不产生 assistant message，partial text_delta 保留在 event 流里。

## 已知边界

不在当前架构内（明确不做或留作后续）：

- LISTEN 连接断线自动重连：依赖 fallback poll 兜底。
- claim 批量化（一次 `LIMIT N` 拉多条）：当前每次拉一条。
- seq 原子化（SEQUENCE）：当前 `MAX(seq)+1`，仅在"同 run 单写者"假设下安全。
- 监控指标（Prometheus / OTel）：未集成。
- Conversation branch / Last-Event-ID：未实现。
- Redis / Celery / LangChain / LangGraph：明确不引入。

## 关联文档

- 模块边界：[`module-boundaries.md`](module-boundaries.md)
- 并发改造细节：[`../handover/2026-05-19-concurrency-and-listen-notify.md`](../handover/2026-05-19-concurrency-and-listen-notify.md)
- Worker/Provider 实现：[`../handover/2026-05-17-provider-and-worker.md`](../handover/2026-05-17-provider-and-worker.md)
- Run events / SSE：[`../handover/2026-05-17-run-events-sse-replay.md`](../handover/2026-05-17-run-events-sse-replay.md)
- 取消机制：[`../handover/2026-05-17-run-cancellation.md`](../handover/2026-05-17-run-cancellation.md)
- 部署：[`../deployment.md`](../deployment.md)、[`../handover/2026-05-18-cicd-and-domain-deployment.md`](../handover/2026-05-18-cicd-and-domain-deployment.md)
