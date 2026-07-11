# 修复 outbox claim、lease 与 attempt 的持久化语义

Type: task

Status: ready-for-agent

Blocked by: None

## What to build

邮件 worker 在调用外部 provider 前持久化可观察的 claim、lease 和发送次数，使并发 worker、进程卡死及发送后崩溃都遵守设计规定的 at-least-once、租约恢复和重试预算语义。

## Acceptance criteria

- [x] claim 和 lease 在调用邮件 provider 前提交，且外部网络调用期间不持续持有数据库行锁。
- [x] `attempt_count` 在真正发起 provider 请求前持久化；发送后崩溃不会回滚本次尝试次数。
- [x] 只有当前 lease 所有者可以完成、重试或终止该次发送，过期 worker 不能覆盖新 worker 写入的状态。
- [x] sweep 可以从另一个数据库会话观察并恢复已过期 lease，同时不会认领仍有效的发送任务。
- [x] 持久化状态和单次处理结果使用不同的明确类型，不能由任意字符串混用。
- [x] PostgreSQL 集成测试覆盖并发 claim、发送前崩溃、发送后崩溃、过期 lease 恢复和重试预算耗尽。

## Comments

2026-07-11：实现完成。发送流程拆为 claim、attempt 和结果写回三个短事务；provider 调用位于事务之外，所有结果写回均校验有效 lease owner。新增 PostgreSQL 跨会话及并发集成测试，并通过全量后端测试、ruff、mypy 与 Alembic schema check。
