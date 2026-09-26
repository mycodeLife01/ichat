# 已登录改密（旧密码校验 + 防爆破限流）

Type: feature

Status: completed

Blocked by: 01

## What to build

已登录用户凭当前密码设置新密码，不走邮件。改密与密码重置是两个不同动作（见 CONTEXT.md）：改密证明「知道旧密码」。改密成功后全设备强制下线、挂起的敏感令牌作废。带 `password` 字段的接口必须防在线爆破——持有被盗会话的攻击者不能靠反复猜旧密码夺号。

## Acceptance criteria

- [ ] 正确旧密码 + 合规新密码：改密生效，返回命令状态响应；新密码可登录、旧密码不可。
- [ ] 改密成功吊销该用户全部 refresh token（当前设备也被踢），并作废其 active 的 `password_reset` 与 `account_deletion` 令牌。
- [ ] 旧密码错误返回明确失败，不改变任何状态。
- [ ] 用户维度失败尝试限流 + IP 限流，Redis 故障 fail-closed（429 + `Retry-After`）；限流参数进入配置模型和环境变量模板。
- [ ] 未登录调用被拒绝（既有认证依赖行为）。
- [ ] HTTP API 层测试覆盖上述全部外部行为，含限流触发与 Redis 故障 fail-closed。

## Comments

（无）
