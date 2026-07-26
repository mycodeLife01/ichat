# 统一聊天导航与桌面移动操作菜单

Type: refactor

Status: completed

Blocked by: 01

## What to build

把聊天外壳中的侧边栏会话项、个人区域、桌面 Dropdown、UserMenu 和移动 BottomSheet 收敛到同一套交互表面规则。用户在桌面与移动端看到的容器层级、菜单项、危险动作和禁用原因应保持一致，只由承载容器适配指针或触摸环境。

重命名、删除会话、打开账户、查看分享和退出登录等现有动作保持原有业务编排；本 ticket 只统一视觉角色、状态表达和可访问交互。

## Acceptance criteria

- [x] 侧边栏会话项、个人区域和普通菜单项消费同一个 interactive-item 规则，并以中性色区分 hover、active 与 selected。
- [x] 桌面会话菜单、UserMenu 和其他聊天外壳 popover 使用统一的 popover 容器；容器圆角高于内部 item 圆角。
- [x] 普通菜单项使用中性 hover/focus/active；危险菜单项默认只使用红色文字和图标，在 hover/focus/active 时使用浅红表面。
- [x] 移动 BottomSheet 使用 card 级顶部圆角和统一遮罩、handle、间距；内部动作与桌面菜单共享动作、禁用条件和禁用原因。
- [x] 移动端可触达控件的有效目标不小于 44×44 CSS px，不存在只能通过 hover 发现的动作。
- [x] 桌面和移动端的重命名、删除、账户、分享与退出路径保持可用，关闭、外部点击和 Escape 行为不回归。
- [x] 菜单、BottomSheet 和侧边栏在窄屏及边缘位置不裁切、不产生横向滚动，并保持清晰 focus-visible。
- [x] 相关测试通过可访问角色和用户可见行为验证菜单开关、动作、危险语义和禁用状态；已有 exact utility class 断言被移除或替换。
- [x] 不改变会话数据、认证状态、路由或 API 契约。
- [x] 前端测试、lint、typecheck 和 production build 全部通过。

## Comments

- 2026-07-23：Sidebar、UserMenu、桌面 Dropdown 与移动 BottomSheet 已统一交互表面、动作语义和无障碍行为；补充侧边栏按压与 three-dot 交互修正。前端 378 项测试、lint、typecheck、production build 及桌面/移动浏览器验收全部通过。
