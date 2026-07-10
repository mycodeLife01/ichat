# 邮箱认证审查修复

修复邮箱认证分支审查发现的生产可靠性、接口契约、前端会话恢复、模块边界和变更范围问题。

需求来源：`docs/superpowers/specs/2026-06-21-email-verification-design.md`

审查基线：`d271bd3edea357630be1055886810181aadcede0...HEAD`

## Ticket map

| ID | Ticket | Status | Blocked by |
|---|---|---|---|
| 01 | 将邮箱认证用例编排移出 API 路由 | `ready-for-agent` | None |
| 02 | 修复 outbox claim、lease 与 attempt 的持久化语义 | `ready-for-agent` | None |
| 03 | 让自动部署同步邮箱服务运行拓扑 | `ready-for-agent` | None |
| 04 | 修复验证页 session 恢复竞态并统一英文文案 | `ready-for-agent` | None |
| 05 | 统一注册与重发验证邮件的邮箱 cooldown | `ready-for-agent` | 01 |
| 06 | 对非法邮箱验证 token 返回 422 | `ready-for-agent` | None |
| 07 | 从邮箱认证变更集中拆出无关代理规则改动 | `ready-for-agent` | None |
| 08 | 执行邮箱认证生产就绪验收 | `ready-for-agent` | 02, 03, 04, 05, 06, 07 |

## Frontier

优先处理所有阻塞项均已完成的 ticket。当前可立即开始：`01`、`02`、`03`、`04`、`06`、`07`。

完成或阻塞 ticket 时，同时更新本索引和对应 issue 文件的状态。
