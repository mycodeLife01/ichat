# 建立 ChatGPT 文字令牌与共享角色

Type: refactor

Status: ready-for-agent

Blocked by: 01

## What to build

在 frontend/src/styles/global.css 和 frontend/src/ui/classes.ts 建立文字系统的单一事实源。

核心实现：

1. 新增 --font-ui，值为 PRD 锁定的 ChatGPT 系统字体栈。
2. 保留 --font-sans 作为 iChat 品牌专用字体，不改变 Wordmark 和 AuthScreen 品牌标题。
3. 建立 uiText、uiLabel、metaText、controlText、composerText、userMessageText、assistantText、reasoningText 等语义角色。
4. 把 primary、tertiary、disabled、user-message 文字颜色映射为语义令牌。
5. 把 .assistant-markdown 和 .sidebar-desktop 的现有正确数值改为消费令牌，computed style 与截图不变。
6. 明确等宽代码、KaTeX 和品牌字体是仅有的字体家族例外。

本 ticket 不切换 html/body 的 15px 根基线，也不批量迁移业务组件。

## Acceptance criteria

- [ ] global.css 存在独立的 --font-ui，回退顺序与 reference matrix 完全一致。
- [ ] --font-sans、--font-mono、--font-serif 的职责有注释，品牌和内容专用字体不会被全局替换。
- [ ] 所有常用字号/行高组合具有语义名称，不需要业务组件拼出半像素字号或小数行高。
- [ ] classes.ts 提供最小而完整的共享文字角色，没有按页面复制相同 class 组合。
- [ ] 助手正文、标题、列表、表格、代码和 Sidebar 的 computed style 与 ticket 01 基线一致。
- [ ] 所有品牌字标的 computed style 和截图边界与 ticket 01 基线一致。
- [ ] html/body 仍保持迁移前根字号，避免未迁移页面被继承式改变。
- [ ] 受影响的单元测试、pnpm run lint、pnpm run typecheck、pnpm run build、相关 visual subset 和 git diff --check 通过。

## Comments

- 2026-08-16：创建 ticket。令牌层必须先做到“无视觉变化”，再允许业务表面迁移。
