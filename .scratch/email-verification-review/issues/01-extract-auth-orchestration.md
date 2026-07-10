# 将邮箱认证用例编排移出 API 路由

Type: task

Status: ready-for-agent

Blocked by: None

## What to build

在保持注册、验证和重发 API 外部行为不变的前提下，将邮箱认证的限流、cooldown、数据库事务补偿和 outbox 投递收拢为认证服务用例，使路由只负责传输层工作。

## Acceptance criteria

- [ ] 注册和重发路由只解析请求、注入依赖、调用认证用例并构造响应，不再直接编排 cooldown、事务补偿或邮件投递。
- [ ] 注册成功、重复邮箱、已验证用户重发、未验证用户重发等现有状态码和响应结构保持不变。
- [ ] 数据库事务失败时，已取得的 cooldown 会被尽力释放；事务提交后的邮件投递失败不会令 API 请求失败。
- [ ] 注册和重发共享的控制流程不再以重复代码形式存在。
- [ ] 自动化测试覆盖成功提交、事务回滚、cooldown 补偿和投递失败降级。

## Comments

暂无。
