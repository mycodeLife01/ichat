# 架构总览

> 本文是 iChat 后端当前运行时架构的总结。模块/目录职责见
> [`module-boundaries.md`](module-boundaries.md)；后台任务归属与可靠性模式见
> [`background-tasks.md`](background-tasks.md)。状态截至 2026-08-01。

## 服务拓扑

前端是独立 React SPA（Cloudflare Pages），经 CORS 调用 FastAPI。后端主要运行组件：

```text
Cloudflare / Browser
        │ HTTPS + SSE
        ▼
Nginx ──► API (FastAPI)
          │  │
          │  ├── PostgreSQL：业务事实源、Run 队列、语义事件、draft checkpoint
          │  └── Redis：SSE Stream、runs_queued 唤醒、认证限流、Celery broker
          │
          ├──────────────► Worker × N（asyncio，流式 LLM Run）
          │                 │
          │                 ├── FOR UPDATE SKIP LOCKED 从 PG claim
          │                 ├── provider chunk → Redis Stream
          │                 └── 低频 run_drafts checkpoint → PG
          │
          └──────────────► Celery workers
                            ├── 邮件 outbox
                            ├── media-worker：头像处理/维护、公开对象 delete + CDN purge
                            ├── file-worker：私有附件扫描、受限解析、回收与私有删除
                            │       └── ClamAV/clamd
                            └── 对话标题生成
```

核心原则：

- PostgreSQL 始终是业务事实源，也是 Run 所有权的唯一仲裁者。
- Redis 是低延迟传输、广播和 broker；故障会降低实时性，但不改变 Run 是否存在、由谁执行、
  最终成功或失败等业务事实。
- API 不调用流式聊天 provider；Worker 不通过 HTTP 向 API 反推事件。
- 标题生成是有限、非流式、可重试任务，归 Celery，不占用流式 Worker 并发槽。
- 文件上传也属于有限、非流式 Celery 任务；`file-worker` 与 `media-worker` 分 queue、分凭证，
  但上传/资产/补偿的事实均在 PostgreSQL。

## 文件上传与消息附件数据流

```text
浏览器 ──预签名单次 PUT / multipart parts──► 私有 files staging bucket
    │ POST confirm（API Complete）            │
    ▼                              ▼
API ── FileUpload queued ──► Celery files queue / file-worker
                                      │ If-Match GET → ClamAV → 受限解析
                                      ▼
                     R2 条件 Copy 原件 + FileAsset/FileObject
                                      │
                         MessageAttachment + Run transcript DocumentBlock
```

1. API 只在 active、已验证邮箱用户创建固定为 `message_attachment` purpose 的上传会话；创建时
   锁住每用户配额行预留声明大小；小文件返回短期 staging PUT URL，支持新协议的大文件返回
   multipart 分片计划，字节均不经 FastAPI。
2. confirm 对 multipart 调用 Complete、对单次 PUT 执行 HEAD，核验后固化 ETag 并把
   `FileUpload` 置为 queued，再尽力投递 files queue。Celery
   丢失只会增加延迟：beat 的有界 sweep 按 PG `available_at` 再次投递。
3. file-worker 按 ETag 用 `If-Match` 条件读取，计算 SHA-256、ClamAV 扫描、在资源受限子进程
   解析并先写 output manifest；成功后在 R2 内条件复制原件到 canonical，再建立 `FileAsset`、
   `FileObject` 和配额转移。新文档派生文本只写 PostgreSQL，不重复写对象存储。
4. 会话服务在同一事务中建立 Message、显式 `MessageAttachment` 和 Run。文档的完整
   `DocumentBlock` 写入 Run transcript；图片只写 `AttachmentNoticeBlock`，不会触发视觉理解。
5. `FileObjectDeletion` 是正式对象删除的 PG 事实。私有对象 delete 完成即可终态；公开头像的
   delete 和 CDN purge 都必须完成。对象存储、Celery 和 CDN 都不是删除事实源。

用途 `avatar` 与 `message_attachment` 共享 files 领域但不可互换。头像仍由 media-worker 处理
公开 `avatar_512` 成品；附件由 file-worker 处理私有原件及派生物。当前仍保留旧头像双读/排空
兼容，contract 收缩必须等待生产前置验证；细节见[统一文件上传交接](../handover/2026-08-01-unified-file-upload.md)。

## 用户消息到回复的端到端数据流

### 1. 入队与唤醒

1. API 在同一 PG 事务内写 user message 和 `runs(status='queued')`。
2. 事务成功 commit 后，API 向 Redis `runs_queued` channel publish 内部 `run.id`。
3. Worker 的 Redis pub/sub listener 收到任意提示后唤醒 claim loop。
4. 信号不携带所有权：Worker 仍用 `FOR UPDATE SKIP LOCKED` claim，并写 lease。
5. Redis publish 丢失或不可用时，`WORKER_POLL_INTERVAL_SECONDS` 周期轮询兜底。

### 2. Agent 执行与事件写入

Worker 加载历史并构建 `ChatAgent`，消费 `ChatAgent.stream()` 产生的 AgentEvent：

- Worker 为每个事件分配单调整数 `seq`。
- 每个 text/reasoning chunk 立即 `XADD run:{internal_run_id}:events`。
- `tool_call_*` 事件同时写 Redis Stream 与 PG `run_events`。
- 首个可见事件把 Run 从 `started` 推进为 `streaming`。
- 累计文本与 reasoning 以低频快照写 `run_drafts`：时间窗、待写字符上限或工具边界先到者触发。
- 成功时物化 assistant message、一次性写 transcript，并在同一 PG 事务内写
  `run_succeeded`；失败/取消同理写对应语义终态。
- Run 终态事件写 PG 后，Worker best-effort 写入 Redis 并把 Stream TTL 缩短；draft 行删除。

Redis XADD 失败只记警告；PG checkpoint、Run 状态机和最终 assistant message 不受影响。

### 3. SSE 与恢复

`GET /api/v1/runs/{id}/events?after_seq=N`：

1. 从 PG 读取 `N` 之后的语义事件（并兼容清理前的存量 delta 行）。
2. 用 Redis `XRANGE` 补齐断线期间事件，按 `seq` 与 PG 结果合并去重。
3. 进入每连接独立的 `XREAD BLOCK` 跟随；多个标签页互不抢占。
4. Redis 不可用或该 Run 的 Stream 缺失时，轮询 `run_drafts`，把累计快照转换为粗粒度
   delta；终态仍从 PG 读取。
5. 收到 `run_succeeded` / `run_failed` / `run_cancelled` 后关闭流。

`GET /api/v1/runs/{id}/state` 使用同一坐标系：

- 以 PG 存量 delta（若有）或 `run_drafts` 为基础快照；
- 拼接 checkpoint `seq` 之后的 Redis 增量；
- 工具状态和终态来自 PG 语义事件；
- Redis 失败时直接返回 PG checkpoint。

SSE 的 `id` / `event` / `data` 帧及 `RunEventResponse` schema 保持不变，前端无需配合改造。

## Run 状态机

```text
queued ──claim──► started ──首个可见事件──► streaming
  │                  │                            │
  │ cancel           ├──────── error ───────────► failed
  ▼                  │                            │
cancelled            ├──────── finish ──────────► succeeded
                     └── cancelling + 协作取消 ─► cancelled
```

- lifecycle 转换使用 `SELECT ... FOR UPDATE` + 当前状态 guard。
- `status` 与 terminal event 在同一 PG 事务内写入。
- claim 后的 Run 持有 `lease_owner` / `lease_expires_at`；heartbeat 续租并检查 cancelling。
- lease 过期 recovery 会综合 PG event、draft checkpoint 与 Redis Stream 的最新 `seq`，再写
  更大的 `run_failed(lease_expired)` 序号，避免与崩溃前的流事件碰撞。

## 持久化模型

| 表 | 角色 |
|---|---|
| `runs` | Run 状态机、PG 队列行、lease、provider/usage 元数据 |
| `run_events` | 语义事件事实源；暂时兼容历史 delta 行 |
| `run_drafts` | 每 Run 一行的累计 text/reasoning checkpoint，供 Redis 故障降级 |
| `run_provider_messages` | provider-neutral content blocks transcript |
| `messages` | 用户可见 user/assistant 消息；assistant 仅在成功终态物化 |
| `file_uploads` | 有期限上传状态机、confirm ETag、lease、尝试数和 output manifest |
| `files` / `file_objects` | 不可变逻辑资产与其 R2 原件/派生物表示 |
| `message_attachments` | Message 到附件资产的显式有序关系与稳定展示元数据 |
| `file_quotas` | 每用户 `used_bytes` / `reserved_bytes` 的事务性配额状态行 |
| `file_object_deletions` | 私有 delete 或公开 delete+purge 的持久化补偿 |

关键约束：

- 同一 conversation 只能有一个 active Run（partial unique index）。
- `(run_id, seq)` 在 `run_events` 与 transcript 中唯一。
- `run_drafts.run_id` 是主键，checkpoint 使用 upsert 覆盖。
- Worker 是正常执行期间每个 Run 的唯一事件写者；seq 在内存中递增。

## Redis 资源与失败策略

### Run Stream

- Key：`run:{internal_run_id}:events`
- Entry：`seq`、`type`、JSON `payload`、`created_at`
- Redis entry ID：`{seq}-0`，便于 XRANGE/XREAD 按同一游标定位
- 容量：`XADD MAXLEN ~ RUN_STREAM_MAXLEN`
- 首写兜底 TTL：`RUN_STREAM_ORPHAN_TTL_SECONDS`
- 终态 TTL：`RUN_STREAM_TTL_SECONDS`
- 客户端连接采用短 connect/socket timeout；失败丢弃该次 Redis 事件，PG 路径继续

### runs_queued pub/sub

- Channel：`runs_queued`
- Producer：API，在业务事务 commit 成功后 publish
- Consumer：每个 Worker 的 `RunQueuedListener`
- 语义：at-least-once 提示，可重复、可丢失、不可作为 claim 依据
- 降级：listener 启动/运行失败时，Worker 继续按 PG poll interval claim

### 部署约束

Redis 与 Celery 共用实例，必须使用 `maxmemory-policy noeviction`。Compose 显式配置该策略；
LLM Worker 不把 Redis health 作为启动前置条件，因此 Redis 在启动时不可用也会进入纯 PG 轮询/检查点降级。

## 并发模型

- 单 Worker 用 `asyncio.Semaphore(WORKER_MAX_INFLIGHT_RUNS)` 限制并行 Run。
- 多 Worker 同时收到 pub/sub 提示后，仍由 PG `SKIP LOCKED` 决定唯一 claim 者。
- 每个 SSE 连接独立 XREAD；不建立 API 进程内共享读者或 consumer group，因此多个标签页都
  能读取同一 Run 的完整事件。
- Delta 不再逐 chunk 占用 PG 连接；PG 写入集中在首个 streaming 转换、低频 checkpoint、
  工具语义事件和终态。

## 关键容量配置

| 变量 | 默认 | 影响 |
|---|---:|---|
| `WORKER_MAX_INFLIGHT_RUNS` | 8 | 单 Worker 并行 Run 上限 |
| `WORKER_POLL_INTERVAL_SECONDS` | 30 | Redis 唤醒丢失时的 PG claim 兜底延迟 |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | 10 | lease 续租与 cancelling 检查频率 |
| `RUN_LEASE_SECONDS` | 60 | Run lease 时长 |
| `RUN_STREAM_MAXLEN` | 2048 | 单 Run Redis Stream 近似长度上限 |
| `RUN_STREAM_TTL_SECONDS` | 600 | 终态 Stream 保留时间 |
| `RUN_STREAM_ORPHAN_TTL_SECONDS` | 86400 | 未正常终态 Stream 的兜底寿命 |
| `DRAFT_CHECKPOINT_INTERVAL_SECONDS` | 3.0 | draft 时间触发窗口 |
| `DRAFT_CHECKPOINT_MAX_PENDING_CHARS` | 4096 | draft 字符量防御上限 |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | 20 / 20 | 单进程 SQLAlchemy 池容量 |
| `FILES_PROCESSING_LEASE_SECONDS` | 300 | 文件处理 claim lease；到期由 beat sweep 恢复 |
| `FILES_PARSER_TIMEOUT_SECONDS` / `FILES_ATTEMPT_TIMEOUT_SECONDS` | 120 / 180 | 受限解析与整次文件处理的上限 |
| `FILES_MAINTENANCE_INTERVAL_SECONDS` | 60 | files queue 的 PG sweep/删除补偿调度间隔 |

## 数据流不变量

1. API 创建 message + Run 与 PG commit 原子；Redis publish 只能发生在 commit 后。
2. Redis 信号和 Stream 都不拥有业务状态或任务所有权。
3. Run terminal status 与 terminal PG event 同事务提交。
4. 新 delta 不写 `run_events`；PG 通过 `run_drafts` 提供粗粒度降级快照。
5. assistant message 只在成功终态物化；失败/取消不产生 assistant message。
6. 标题任务仅更新 `title IS NULL` 且首个成功 Run 的 conversation，重复投递安全。
7. 前端可见 SSE 契约保持冻结；内部传输变化不要求前端同步部署。
8. 附件原件不进入 provider；目标用户 turn 使用完整 DocumentBlock 快照或图片 notice，超预算
   必须在提交前拒绝，不能静默截断。
9. 文件读取、配额、资产回收和对象删除均经 files 服务；会话/Run 历史不能通过 R2 重新构造事实。

## 关联文档

- 模块边界：[`module-boundaries.md`](module-boundaries.md)
- 后台任务约定：[`background-tasks.md`](background-tasks.md)
- Agent 04b 决策：[`../handover/2026-07-20-agent-runtime-refactor-04b-decisions.md`](../handover/2026-07-20-agent-runtime-refactor-04b-decisions.md)
- Agent 04b 实施：[`../handover/2026-07-20-agent-runtime-refactor-04b-implementation.md`](../handover/2026-07-20-agent-runtime-refactor-04b-implementation.md)
- 统一文件上传：[`../handover/2026-08-01-unified-file-upload.md`](../handover/2026-08-01-unified-file-upload.md)
- 部署：[`../deployment.md`](../deployment.md)
