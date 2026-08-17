# 建立 ChatGPT 文字令牌与共享角色

Type: refactor

Status: completed

Blocked by: 01

## What to build

在 frontend/src/styles/global.css 和 frontend/src/ui/classes.ts 建立文字系统的单一事实源。

核心实现：

1. 新增 --font-ui，值为 PRD 锁定的 ChatGPT 系统字体栈。
2. 保留 --font-sans 作为 iChat 品牌专用字体，不改变 Wordmark 和 AuthScreen 品牌标题；桌面 Sidebar 字标继续保留 ticket 01 冻结的系统字体 scoped 例外。
3. 建立 uiText、uiLabel、metaText、controlText、composerText、userMessageText、assistantText、reasoningText 等语义角色。
4. 把 primary、tertiary、disabled、user-message 文字颜色映射为语义令牌。
5. 把 .assistant-markdown 和 .sidebar-desktop 的现有正确数值改为消费令牌，computed style 与截图不变。
6. 明确等宽代码、KaTeX 和品牌字体是仅有的字体家族例外。

本 ticket 不切换 html/body 的 15px 根基线，也不批量迁移业务组件。

## Acceptance criteria

- [x] global.css 存在独立的 --font-ui，回退顺序与 reference matrix 完全一致。
- [x] --font-sans、--font-mono、--font-serif 的职责有注释，品牌和内容专用字体不会被全局替换。
- [x] `.sidebar-desktop .wordmark` 的系统字体 scoped 例外继续满足 ticket 01 computed-style 与边界基线。
- [x] 所有常用字号/行高组合具有语义名称，不需要业务组件拼出半像素字号或小数行高。
- [x] classes.ts 提供最小而完整的共享文字角色，没有按页面复制相同 class 组合。
- [x] 助手正文、标题、列表、表格、代码和 Sidebar 的 computed style 与 ticket 01 基线一致。
- [x] 所有品牌字标的 computed style 和截图边界与 ticket 01 基线一致。
- [x] html/body 仍保持迁移前根字号，避免未迁移页面被继承式改变。
- [x] 受影响的单元测试、pnpm run lint、pnpm run typecheck、pnpm run build、相关 visual subset 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。令牌层必须先做到“无视觉变化”，再允许业务表面迁移。
- 2026-08-16：开始前确认 `.scratch/ui-system-unification/issues/09-conformance-and-visual-acceptance.md` 仍为 `ready-for-agent`，其 01–08 前置均已完成；当前工作区的 `global.css` / `classes.ts` 无未提交重叠。本票以独立 `type-*` 文字命名空间补充既有 surface/status 系统，没有代替 09 的全局合规收口。
- 2026-08-16：在 `global.css` 建立精确 `--font-ui`、品牌/代码/衬线/KaTeX 字体职责、语义字号/行高/字重和 primary/secondary/tertiary/disabled/user-message 颜色令牌；只令牌化已正确的 `.assistant-markdown` 与 `.sidebar-desktop`。`html/body` 继续使用 15px/`--font-sans`，`.sidebar-desktop .wordmark` 继续继承系统栈。
- 2026-08-16：在 `classes.ts` 建立 UI、Meta、标题、表单、Composer、用户消息、助手、思考、附件、来源和状态密度角色；未迁移生产业务 JSX。`typography-system` fixture 新增共享角色与根基线 computed-style 契约，并继续覆盖所有 Wordmark 边界。
- 2026-08-16：验证通过：Vitest 74 files / 634 tests、ESLint、TypeScript typecheck、production build、Playwright 8 passed / 2 configured skips，以及 `git diff --check`；构建仅保留既有的大 chunk 提示。
