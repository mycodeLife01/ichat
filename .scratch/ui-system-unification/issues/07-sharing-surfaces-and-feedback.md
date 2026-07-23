# 统一分享管理与公开分享界面

Type: refactor

Status: ready-for-agent

Blocked by: 01, 02

## What to build

统一会话分享 Dialog、我的分享列表和公开分享页面的 card/dialog、操作项及反馈语义。创建、复制和撤销分享的结果应通过明确 tone 呈现；公开页面中的加载、不可访问和内容展示则使用持续状态，不依赖短暂通知。

所有分享能力继续使用现有快照、token、撤销和公开访问契约。

## Acceptance criteria

- [ ] 分享 Dialog、分享列表卡片和公开分享表面使用统一的 dialog/card、边框、阴影和语义圆角角色。
- [ ] 创建、复制和撤销成功使用 success Toast；加载、创建、复制和撤销失败使用 error Toast，并保留明确的操作文案。
- [ ] 撤销入口遵循 danger action 规则，但普通选中、复制和创建状态继续使用中性系统。
- [ ] 加载中、无分享、公开链接不可访问和其他持续页面状态使用带图标与正确角色的行内状态，不仅依赖颜色。
- [ ] 按钮在 loading 和 disabled 时阻止重复提交、保留可理解标签，并保持尺寸稳定。
- [ ] 分享页面及弹窗不包含组件级 UI 硬编码颜色、重复 arbitrary radius、inline danger style 或任意遮罩/阴影。
- [ ] 桌面和移动端均可完成创建、复制、撤销、关闭和公开阅读流程，无菜单裁切或横向滚动。
- [ ] 测试从用户可见行为验证分享成功/失败 tone、危险撤销、持续状态和可访问语义，不断言具体 utility。
- [ ] 分享 API、快照语义、token、路由和数据展示内容保持不变。
- [ ] 前端测试、lint、typecheck 和 production build 全部通过。

## Comments

