# 发起注销（sudo 密码 + 确认邮件）

Type: feature

Status: completed

Blocked by: 01

## What to build

已登录用户发起注销账户：必须重输当前密码（sudo mode——「已登录」不等于「是本人」），校验通过后签发 `account_deletion` 令牌（30 分钟 TTL，独立配置项）并经 outbox 发出注销确认邮件。邮件含「如非本人操作请立即修改密码」提示。console provider 下可演示收信。

## Acceptance criteria

- [ ] 正确密码：签发令牌、outbox 入列、邮件含指向前端注销确认页的 30 分钟有效链接与非本人操作警示；返回命令状态响应。
- [ ] 密码错误返回明确失败，不发信、不签发令牌。
- [ ] 限流按 resend 模式：fail-closed + 用户/邮箱冷却（60 秒，按 `account_deletion` purpose 独立计）+ IP 限流；任一命中返回 429 + `Retry-After`；Redis 故障拒绝服务。
- [ ] 重复发起（冷却窗口外）撤销旧令牌、签发新令牌——同用途仅一个 active（既有语义）。
- [ ] 注销确认邮件模板复用品牌化 HTML 卡片渲染器，渲染器单元测试扩展覆盖。
- [ ] 新 TTL 配置项与限流参数进入配置模型和环境变量模板。
- [ ] HTTP API 层测试覆盖上述全部外部行为。

## Comments

（无）
