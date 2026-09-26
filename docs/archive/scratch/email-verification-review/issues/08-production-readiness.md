# 执行邮箱认证生产就绪验收

Type: task

Status: completed

Blocked by: 02, 03, 04, 05, 06, 07

## What to build

在完整依赖环境中验证邮箱认证从注册、异步发送到公开验证和用户状态刷新的端到端行为，并留下可复现的生产就绪证据。

## Acceptance criteria

- [x] 在 PostgreSQL 和 Redis 可用的环境中运行完整后端测试、lint 和严格类型检查并全部通过。
- [x] 运行完整前端测试、lint、类型检查和生产构建并全部通过。
- [x] 开发与生产 Compose 配置均通过解析校验，所有预期服务能够启动并达到健康状态。
- [x] 使用非生产邮件 provider 完成“注册 → outbox → worker 发送 → 验证链接 → `/auth/me` 显示已验证”的 smoke test。
- [x] smoke test 同时验证重发 cooldown、非法 token、重复链接和 worker lease 恢复行为。
- [x] 验证结果、执行命令和任何仍需人工完成的生产运维步骤记录到项目交接文档。

## Comments

2026-07-12：生产就绪验收完成。后端 346 tests、Ruff、严格 MyPy 全部通过；前端 56 files / 323 tests、ESLint、TypeScript typecheck 和生产构建全部通过。开发与生产 Compose 解析通过，开发完整拓扑启动成功，PostgreSQL/Redis healthy、API liveness/readiness 正常、Celery worker ping 正常。使用 `console` provider 完成真实 API + PostgreSQL + Redis + Celery smoke，覆盖注册发送、cooldown 429、非法 token 422、验证成功、`/auth/me` 刷新、重复链接 400 和过期 lease sweep 恢复。详细命令、结果与生产人工运维项见 `docs/handover/2026-06-26-email-verification.md`。
