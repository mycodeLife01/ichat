# 后台任务约定

> 本文把项目已在实践、但从未成文的后台任务模式明文化，终结「新任务归谁执行」的
> 逐案争论。约定与 [架构总览](overview.md)、[模块边界](module-boundaries.md) 及
> [邮件验证交接](../handover/2026-06-26-email-verification.md) 与 [统一文件上传交接](../handover/2026-08-01-unified-file-upload.md) 一致。

## 1. 统一模式

**所有后台任务遵循同一骨架**：

```
事务性状态行（PG 为事实源） + 唤醒信号（仅加速器，可丢失） + 幂等 claim
```

- **事务性状态行**：任务的存在性、进度、终态全部落在 PostgreSQL 的一张状态表里。
  入队与产生该任务的业务写入在**同一事务**内提交——业务成功则任务必然存在，业务
  回滚则任务不残留，不存在「消息已发但库里没有」或反之的裂缝。PG 是唯一事实源。
- **唤醒信号**：一个「有新活儿了」的提示，用来把「下一次 claim」从轮询延迟压到近实时。
  它**只是加速器**，允许丢失——信号没送到，兜底的 sweep/poll 迟早会扫到那一行。
  因此唤醒信号可以放在 PG 的 `LISTEN/NOTIFY`、Redis、或任何广播机制上，坏了不影响
  正确性，只影响时延。
- **幂等 claim**：worker 用一次原子的「有条件 UPDATE + 租约（lease）」把状态行从
  `pending` 抢成 `in-progress`，条件里带上「未被占用 / 租约已过期 / 到达可执行时间」。
  抢到才干活。多个 worker、重复投递、崩溃重放都安全：同一行只会被一个活着的租约持有，
  租约过期后由 sweep/recover 归还。

### 三条现存链路都是该模式的实例

| 维度 | LLM run（自研 async 运行时） | 邮件发送（Celery） | 文件处理/删除补偿（Celery） |
|------|------------------------------|--------------------|--------------------------------|
| 状态表 | `runs`（`status`、`lease_expires_at`、`heartbeat_at`…） | `email_outbox`（`status`、`locked_until`、`attempt_count`…） | `file_uploads`（状态、lease、`available_at`、attempt）、`file_object_deletions`（分步 delete/purge）、配额与资产生命周期行 |
| 入队 | 写 user message + 建 `runs` 行，同事务提交 | 业务事务内插入 `email_outbox` 行 | confirm 在 PG 中把 `FileUpload` 置 queued；资产删除在同一事务建立 `FileObjectDeletion` |
| 唤醒信号 | commit 后 Redis `PUBLISH runs_queued`（`app/services/runs/wakeup.py` + `app/worker/run_queued_listener.py`） | Celery 任务投递（`send_task`，携带 `outbox_id`） | Celery `files` queue（携带 upload public ID）；任务投递失败只增加延迟 |
| 兜底 | worker 周期 poll + 租约过期 recover | `celery-beat` 周期 `sweep_outbox` 归还过期租约、补投 due 行 | 单实例 beat 投递 `maintain_files`：归还过期 lease、补投 due、清理 staging、回收资产、处理删除补偿、reconcile quota |
| 幂等 claim | `FOR UPDATE SKIP LOCKED` 抢 run + 写 lease（`app/services/runs/lifecycle.py`） | 原子 `UPDATE ... RETURNING` 抢 `pending→sending` + `locked_until`（`app/services/email/outbox.py`） | `FileUpload` 行锁 + purpose/status/lease owner 条件；终态和 manifest 可重复读取，重复 Celery 消息不会再次产生资产 |
| 事实源 | PostgreSQL | PostgreSQL | PostgreSQL |
| Redis/Broker 角色 | pub/sub 唤醒 + Run Stream 实时传输；不参与 claim 仲裁，PG poll/checkpoint 兜底 | 仅作 broker/加速器，不持有业务状态 | 仅作 broker/加速器；`available_at`、lease 与补偿完成时间在 PG |

三条链路都**只把 PG 当事实源**，把广播组件（Redis pub/sub / Stream、Celery broker）当加速器。
唤醒信号即便全部丢失，兜底扫描仍能保证任务最终被执行——这是「Redis 只作加速器、
PG 永远是事实源」这一项目级约定在后台任务上的落地。

## 2. 归属判据：自研 async 运行时 还是 Celery？

**看任务形状，不看是否调用 LLM。**

| 任务形状 | 归属 |
|----------|------|
| 流式、交互、需要中途取消（协作式取消 + 心跳精度要求） | **自研 async 运行时**（如 LLM run worker） |
| 有限时长、非流式、fire-and-forget、可重试 | **Celery**（如邮件发送、头像处理、文件扫描/解析/回收、标题生成） |

判据是任务的**运行形态**，而非它「是不是 AI 任务」。标题生成同样调用 LLM，但它
有限、非流式、可重试、不需要中途取消，因此归 Celery（见
[ticket 05](../../.scratch/agent-runtime-refactor/issues/05-title-generation-celery.md)）；
而一次流式对话 run 虽然也是「一个后台任务」，却因为流式 + 可取消 + 长时租约而必须
留在自研运行时。

标题任务的三问答案：最多重试 3 次；以 5 秒为基数做指数退避并封顶 60 秒；耗尽后
Celery 将任务标为失败并记录日志，conversation `title` 保持 NULL（不污染业务事实），后续
首个成功 Run 的重复投递仍可按 `title IS NULL` 幂等补写。

文件任务的三问答案：上传处理最多 3 次；暂时故障按 30 秒、5 分钟退避，第三次耗尽进入
`failed`；格式/安全/资源上限等永久失败进入 `rejected`。`FileObjectDeletion` 不因短暂
外部故障丢弃，按其 `available_at` 持续重试至私有 delete 或公开 delete+purge 均完成。
`file-worker` 只消费 `files` queue；`media-worker` 只消费 `media` queue。二者共享 files
状态机而不共享不可信文档解析或公开 CDN 权限。

## 3. 反例：为什么流式 LLM run 不进 Celery

把流式对话 run 塞进 Celery 会在下面每一点上碰壁，这也反向说明了归属判据的由来：

- **协作式取消 vs revoke**：用户点「停止」要求 run 在下一个 chunk 边界干净地收尾
  （落库已产出的部分、置 `cancelled`）。Celery 的 `revoke`/`SIGTERM` 是粗暴中断，
  无法表达「到安全点再停」；自研运行时用 `cancelling` 状态 + 心跳轮询实现协作式取消。
- **租约心跳精度**：run 需要秒级心跳续租，崩溃后由租约过期快速 recover。Celery 的
  ack/visibility 机制粒度粗、不为「持续心跳 + 精细 recover」设计。
- **事务性入队**：run 必须与 user message 在同一 PG 事务内落库，二者同生同死。
  Celery 的入队是对 broker 的独立投递，做不到与业务写入原子提交。
- **asyncio 并发模型 vs prefork**：一个 run 长时间挂在流式 I/O 上，async 单进程可高效
  并发承载多条 run；Celery 默认 prefork，每条长连接占一个进程，并发成本高。
- **长任务与 visibility timeout 互斥**：流式 run 时长不确定，可能远超 broker 的
  visibility timeout，导致消息被判定超时而重复投递，与「一条 run 唯一写者」冲突。

## 4. 每类任务表必须回答的三个问题

新增一类后台任务时，其状态表设计**必须**明确回答：

1. **重试几次？**——最大尝试次数（如 `email_outbox_max_attempts`）。
2. **退避多少？**——两次尝试之间的退避策略（如邮件的指数退避
   `1m/5m/15m/1h/6h`，见 `BACKOFF_SCHEDULE_SECONDS`）。
3. **死了落到哪？**——尝试耗尽后的终态与去向（如 `email_outbox` 的 `dead` 状态 +
   `last_error`；run 的 `failed` + 错误码/信息）。

三个问题没有答案的任务表不算设计完成。

## 相关文档

- [架构总览](overview.md) — 服务拓扑、run 状态机、LISTEN/NOTIFY 频道。
- [模块边界](module-boundaries.md) — `app/worker`、`app/services/runs`、`app/tasks` 职责。
- [邮件验证交接](../handover/2026-06-26-email-verification.md) — Celery/Redis/outbox 细节。
- [统一文件上传交接](../handover/2026-08-01-unified-file-upload.md) — files 状态机、manifest、删除补偿、ClamAV 与部署/灰度要求。
