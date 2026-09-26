# 完成全局设计系统合规与浏览器视觉验收

Type: refactor

Status: ready-for-agent

Blocked by: 02, 03, 04, 05, 06, 07, 08

## What to build

在所有纵向迁移完成后执行全局收口：机械检查生产代码是否仍绕过语义设计系统，修复残留项，并在真实浏览器中验证桌面、移动、交互状态、对比度和响应式布局。最终结果应证明设计系统不仅存在，而且已经成为所有目标界面的单一事实源。

经确认的静态对比页和交互体验页仅作为评审基准，不接入生产路由、构建入口或部署。

## Acceptance criteria

- [ ] 业务 JSX 中不存在 UI 用十六进制/rgba 颜色、组件级遮罩/阴影或 inline danger style；确有必要的非 UI 例外集中管理并明确记录。
- [ ] 除已命名的 detail、composer 等语义角色外，不存在重复 arbitrary radius；所有目标组件均可追溯到 PRD 的圆角决策表。
- [ ] danger 与 error 使用同一红色家族，普通 hover/selected/disabled 不使用 success、warning 或 danger；success/warning utility 在 production build 中真实存在。
- [ ] 所有 Toast 调用点显式携带 tone，所有持续状态使用共享行内状态原语或同等语义实现。
- [ ] 受本次改造影响的测试只断言用户行为和可访问语义，不再把 Tailwind utility 拼接当作主要契约。
- [ ] 真实浏览器覆盖 1280×800 桌面，以及 320、375、390/414、768 CSS px 移动/窄屏视口；无横向滚动、菜单裁切、Dialog 偏移或 BottomSheet 异常。
- [ ] 浏览器状态矩阵覆盖侧边栏项、用户区域、Dropdown、UserMenu、BottomSheet、四种 Toast、行内状态、ConfirmDialog、账户 Card、Composer、输入框状态和消息气泡。
- [ ] 主文本达到 WCAG 4.5:1；图标、控件边界和 focus ring 达到 3:1；键盘焦点清晰，移动主要触摸目标不小于 44×44 CSS px。
- [ ] 经确认的评审参考资产没有进入生产路由或构建入口；本次变更不包含后端、数据库、API 或 Run 状态机修改。
- [ ] `pnpm exec vitest run`、`pnpm run lint`、`pnpm run typecheck` 和 `pnpm run build` 全部通过，浏览器验收结果追加到本 ticket 的 Comments。

## Comments

