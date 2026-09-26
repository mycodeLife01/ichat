# ADR + 文档 + 端到端验收

Type: task

Status: completed

Blocked by: 03, 04, 06

## What to build

为「注销 = 软停用 + 延后物理清除」补 ADR（难逆、反直觉、真实权衡三条件均满足），更新交接文档，并对五个新端点做完整验收——对照上一期邮箱验证 production-readiness ticket 的先例。

## Acceptance criteria

- [ ] 新增 ADR 记录注销软停用决策：背景（级联外键的物理删除不可逆）、备选（软注销 / 冷静期清除 / 立即物理删除）、决策与后果（物理清除为后续迭代的接续点）。
- [ ] 交接文档更新：五个新端点、交叉作废矩阵、邮箱验证不变量扩展、限流映射、新环境变量、「注销后恢复需运维手工、恢复入口不借道密码重置」的运维说明。
- [ ] 环境变量模板与配置文档核对齐全（两个 TTL + 三组限流参数）。
- [ ] 后端测试、lint、类型检查全绿（运行前停 LLM worker 与 celery-worker 容器）。
- [ ] console provider 下完整 smoke：申请重置 → 收信 → 重置 → 新密码登录；改密 → 全设备下线；发起注销 → 收信 → 确认 → login/refresh/me 全被拒；防枚举恒定响应与冷却 429 抽查。
- [ ] 上线注意事项写入交接文档：生产 `.env` 增补新变量后 force-recreate api / celery-worker / celery-beat；前端页面就位前邮件链接为死链，依赖前端不提供入口。

## Comments

（无）
