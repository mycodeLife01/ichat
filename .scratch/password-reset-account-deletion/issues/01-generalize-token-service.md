# 预构：令牌服务按 purpose 泛化 + 全量吊销 refresh token 助手

Type: task

Status: completed

Blocked by: None

## What to build

把认证令牌的签发与消费从硬编码「邮箱验证」用途泛化为按 purpose 参数化，新增 `password_reset` 与 `account_deletion` 两个用途常量；同时提供「吊销某用户全部 refresh token」的可复用能力。这是唯一的横切预构——先让后续改动变容易。对外部行为零变化：邮箱验证流程一切照旧。

## Acceptance criteria

- [ ] 令牌签发/消费函数接受 purpose 参数；同用户同用途仅一个 active 令牌、签发新令牌撤销同用途旧令牌的既有语义在任意 purpose 下成立。
- [ ] 不同 purpose 的令牌互不可消费（拿重置令牌调验证消费必须失败，反之亦然）。
- [ ] 新增「吊销某用户全部未过期 refresh token」助手，吊销后这些 token 无法再换取新凭证。
- [ ] 邮箱验证的注册/重发/验证外部行为不变，现有测试套件全绿。
- [ ] 令牌服务单元测试扩展覆盖 purpose 隔离与全量吊销（复用既有令牌服务测试的缝，不新增测试缝）。

## Comments

（无）
