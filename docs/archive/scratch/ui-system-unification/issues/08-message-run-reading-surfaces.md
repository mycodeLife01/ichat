# 统一消息、Run 状态与引用阅读表面

Type: refactor

Status: completed

Blocked by: 01

## What to build

统一消息气泡、消息操作、思考区、Run 持续状态、引用 popover 和来源面板的层级与状态表达。用户在阅读对话时应清楚区分普通内容、可操作控件、生成失败、已停止和来源详情，同时桌面与移动动作继续共享相同业务规则。

## Acceptance criteria

- [x] 用户消息气泡、消息操作按钮、思考区细节和 Markdown 细节分别消费明确的 card/item/control/detail 角色，不保留无名圆角。
- [x] 桌面消息操作与移动 BottomSheet 继续共享复制、编辑并重发、重新生成及禁用原因；移动触摸目标不小于 44×44 CSS px。
- [x] Run failed 在消息上下文中持续显示 error 状态及可理解文案；cancelled 使用中性持续状态；二者均不只通过颜色表达。
- [x] Run failed 不重复触发相同含义的 Toast，已有 partial 内容和重试/继续阅读行为保持不变。
- [x] Citation popover 使用共享 popover 与 item 层级，父容器圆角高于内部条目，边缘位置不裁切。
- [x] 来源面板、公开来源条目和消息阅读表面使用统一 card/surface、边框和文字层级。
- [x] Markdown 代码、骨架和其他小型细节使用 detail 角色；语法高亮等必要非业务色值集中在主题层或白名单样式中。
- [x] 消息与阅读组件不包含 UI 用硬编码颜色、重复 arbitrary radius、inline style 或任意阴影。
- [x] 测试通过可访问角色和用户行为覆盖 Run failed/cancelled、消息动作、引用与来源开关，并移除受影响的 exact utility class 断言。
- [x] SSE、Run 状态、消息数据、Markdown 安全策略和分享内容契约保持不变；前端测试、lint、typecheck 和 production build 全部通过。

## Comments

- 2026-07-24：消息气泡/编辑器/SourcesTrigger 迁移到 messageBubble、buttonControl/primaryButton、pill 角色（SharePage 复用同一气泡原语）；MessageAction 与代码/引用/来源图标按钮消费 iconControl 并补 44px 移动触摸目标；Run failed/cancelled 改为持续 InlineStatus（error=alert、neutral=status），无重复 Toast（useRunStream 测试已有断言）；Citation chip/card 用 pill + popoverSurface（内部条目 rounded-item 低于容器）；SourcesPanel 统一语义 surface/text 与 bg-overlay scrim；.md code/pre 用 --radius-detail、语法高亮 token 在 global.css 白名单注释记录；删除失去消费者的 msgAction/ghostBtn/primaryBtn；测试改为角色/tone/图标断言。前端 403 项测试、lint、typecheck、production build 全部通过。提交 c7be1a5。
- 备注：Citation chip、ThinkingBlock 折叠开关、用户气泡展开/收起按钮仍小于 44px（AC2 范围为消息操作与 BottomSheet）；已留给 09 视觉验收统一裁定。