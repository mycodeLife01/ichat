# 对非法邮箱验证 token 返回 422

Type: task

Status: ready-for-agent

Blocked by: None

## What to build

验证 API 在访问数据库前区分 token 格式错误和有效格式但已失效的链接，为调用方提供符合设计的稳定错误契约。

## Acceptance criteria

- [ ] 仅接受系统签发的 43 字符 URL-safe token 格式。
- [ ] 缺失、空白、过短、过长或包含非法字符的 token 返回 422，且不执行 token 数据库查询。
- [ ] 格式合法但不存在、过期、撤销或已使用的 token 继续返回通用 400，不泄露具体原因。
- [ ] 合法 token 的成功验证行为和响应结构保持不变。
- [ ] API 测试分别覆盖格式错误、合法但失效及成功验证。

## Comments

暂无。
