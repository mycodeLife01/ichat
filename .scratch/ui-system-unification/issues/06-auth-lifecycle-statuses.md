# 统一认证与账户生命周期页面状态

Type: refactor

Status: ready-for-agent

Blocked by: 01, 02

## What to build

把登录注册、密码重置、邮箱验证和注销确认页面迁移到统一的表单、卡片和状态语义。用户在这些独立页面中应获得与聊天内账户面板一致的输入状态、持续成功、提醒、失败和 loading 反馈，而不改变现有认证流程。

## Acceptance criteria

- [ ] 登录注册入口、密码重置、邮箱验证和注销确认页面使用统一的 card/dialog、control、item 和 button 角色。
- [ ] 输入框在 default、hover、focus-visible、disabled、loading、error 和适用的 success 状态下保持固定边框宽度与几何尺寸。
- [ ] 字段错误显示在对应输入附近，使用 `aria-invalid` 和关联错误文案；跨表单失败使用 error 行内状态或 error Toast，不只改变颜色。
- [ ] 邮箱验证成功、密码重置成功等持续结果使用 success 状态；链接待处理或需要用户关注的情况使用 warning，不复用 danger。
- [ ] 提交中和 disabled 控件同时具有正确行为、视觉降权及可理解的标签或进度图标。
- [ ] 所有交互入口具有清晰 focus-visible；窄屏页面无横向滚动、内容裁切或不足 44×44 CSS px 的主要触摸目标。
- [ ] 页面不包含 UI 用硬编码颜色、重复 arbitrary radius、组件级遮罩或阴影值。
- [ ] 测试通过可访问角色验证校验失败、API 失败、成功、重复/失效链接和 loading 行为，不以 utility class 作为契约。
- [ ] 路由、认证令牌、会话恢复、API 请求和既有文案意图保持不变。
- [ ] 前端测试、lint、typecheck 和 production build 全部通过。

## Comments

