Type: refactor
Status: ready-for-agent
Blocked by: 06

# runs_queued 唤醒信号迁移 Redis（原阶段 4b）

## 目标

worker 等待新 run 的唤醒信号从 `pg_notify('runs_queued')` + 专用 asyncpg LISTEN
连接，迁移为订阅 Redis；删除 notify_listener 模块与常驻 LISTEN 连接，唤醒基础设施
与流式广播（06）共用同一 Redis。

## 边界约束（不可违反）

- **claim 仲裁保留在 PG**：`FOR UPDATE SKIP LOCKED` 是唯一的所有权仲裁，Redis
  信号只是 at-least-once 的提示，不携带任何所有权语义。
- **投递时机**：`pg_notify` 是事务内排队、commit 时投递；Redis publish 没有该
  耦合，改为**事务 commit 成功后**再 publish。commit 后进程崩溃导致的信号丢失，
  由 worker 既有的 `worker_poll_interval_seconds` 兜底轮询覆盖——该轮询保留，
  语义不劣化。

## 范围

1. 三处入队点（发消息/编辑重生成/重试）的 `pg_notify('runs_queued')` 改为
   commit 后 Redis publish（沿用 `runs_queued` 频道名；简单 pub/sub 即可，
   唤醒信号无需回放）。
2. worker 侧：`RunQueuedListener`（asyncpg LISTEN）替换为 Redis 订阅实现，
   等待接口语义不变（收到任意信号即唤醒、合并多次通知）；Redis 订阅不可用时
   退回纯轮询模式（与现状 LISTEN 启动失败的降级行为一致）。
3. 删除 notify_listener 模块及其 DSN 转换工具（确认 06 已删除其另一处引用）。

## 验收

- `pytest` / `ruff` / `mypy` 全绿。
- dev 验证：发消息后 run 立即被 claim（非轮询间隔粒度）；停 Redis 后发消息，
  run 在一个轮询间隔内仍被 claim（降级路径）。
- grep 确认 `runs_queued` 的 pg_notify 与 LISTEN 无残留。

## Comments
