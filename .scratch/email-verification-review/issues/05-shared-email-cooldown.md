# 统一注册与重发验证邮件的邮箱 cooldown

Type: task

Status: ready-for-agent

Blocked by: 01

## What to build

注册和重发共同遵守同一邮箱维度的发送保护窗口，同时保留登录用户维度和 IP 维度的限制，避免新注册用户立即触发第二封验证邮件。

## Acceptance criteria

- [x] 注册成功取得的邮箱 cooldown 会阻止保护窗口内对同一邮箱执行重发。
- [x] 重发同时执行用户、邮箱和 IP 三个维度的保护；任一限制命中均返回带 `Retry-After` 的 429。
- [x] 已验证用户调用重发保持幂等成功，且不占用 cooldown 或 IP 配额。
- [x] 数据库事务失败时，本次请求新取得的全部 cooldown key 都会被尽力释放。
- [x] Redis 不可用时，注册继续按设计使用数据库邮箱 cooldown 降级，重发继续 fail closed。
- [x] 自动化测试覆盖注册后立即重发、窗口到期、事务回滚、已验证用户及 Redis 故障策略。

## Comments

2026-07-11：已统一 user/email cooldown，并覆盖部分获取失败与事务回滚补偿。
