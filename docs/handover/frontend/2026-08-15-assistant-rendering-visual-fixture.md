# 助手回复视觉 fixture 交接

- 日期：2026-08-15
- 分支：`refactor/ai-chat-render`
- 范围：`.scratch/refactor-chat-render/` 的 ticket 01；下一步从 ticket 02 开始。

## 当前结论

视觉 fixture 是一个隔离、可重复的助手回复展示与浏览器验收入口。ChatGPT 只作为
2026-08-15 的点时视觉参考；fixture 没有复制 ChatGPT 的 DOM 或 CSS，而是使用脱敏静态内容
驱动 iChat 现有的 `MessageThread`、`Markdown` 和 `ThinkingBlock`，因此展示的是 iChat 当前
生产组件和样式。

参考环境、桌面与 390px 移动端 computed-style 数据见
`frontend/tests/visual/assistant-rendering-reference.md`。fixture 外层自己的 CSS 只负责测试展台
布局，不是待复刻的 ChatGPT 样式；后续 ticket 应修改生产渲染实现，并使用本入口对照参考值。

## 已完成

- ticket 01 的范围、验收项和验证记录已收敛在
  `.scratch/refactor-chat-render/issues/01-reference-fixture-and-visual-harness.md`。
- 独立入口为 `frontend/tests/visual/assistant-rendering.html`，不依赖认证、API、SSE 或正式
  Router，也不会进入默认 `vite build` 的生产入口。
- fixture 覆盖完整 GFM/KaTeX/citation 内容、六类未闭合流式 Markdown、Clipboard 成功与失败、
  `ThinkingBlock` 折叠与展开；内容和来源均为本地脱敏数据。
- `frontend/playwright.config.ts` 固定浅色主题、reduced motion、`deviceScaleFactor = 1`，并在
  `1440 × 900` 与 `390 × 844` 两个 viewport 运行。
- Playwright smoke 检查 surface、复制交互、thinking 语义、宽度和页面 overflow，并把几何 JSON
  与全页截图写入已忽略的 `frontend/output/playwright/`。
- PRD 已将 ticket 01 标为完成，frontier 已推进到 ticket 02。

## 验收边界

当前截图只是诊断 artifact，测试没有调用 `toHaveScreenshot()`，也没有提交 golden baseline，
所以轻微像素漂移暂时不会自动使测试失败。经人工确认后的桌面和移动 golden 由 ticket 06
固化；在此之前不要把 ticket 01 的改造前画面批准为长期基线。

fixture 的 smoke 能证明页面可加载、目标状态存在、关键交互可达且没有页面级水平溢出；它不能
单独证明已经完成 ChatGPT 风格 1:1 对齐。目标样式及误差标准以
`.scratch/refactor-chat-render/PRD.md` 为准。

## 下一步

从 `.scratch/refactor-chat-render/issues/02-assistant-typography-and-markdown-seam.md` 开始：

- 保留现有 `MarkdownProps` 和 final、streaming、share 三个调用入口；不增加
  `AssistantRenderModel` 或后端展示契约。
- 在生产样式中引入助手专用 768px 内容列和 scoped typography；不要把 fixture 展台 CSS 当作
  目标实现。
- 严格遵守 ticket 02 的 reasoning freeze，不修改 `ThinkingBlock.tsx`、`reasoningPreview.ts`
  或 `runs/state.ts` 的行为。
- 用 ticket 01 的实测移动数据验证 390px 页面无水平 overflow，并更新诊断截图，但仍不固化
  golden。

完整范围、依赖顺序、验收标准和验证命令只维护在 PRD 与各 ticket 中，本交接不重复展开。

## Suggested skills

- `$tdd`：实现 ticket 02 时先固定 Markdown 三入口与 reasoning 的现有行为，再调整排版。
- `$playwright`：运行和检查独立视觉 fixture 的桌面、移动 viewport、几何数据与诊断截图。

## 验证

ticket 01 提交前已重新执行：

```bash
cd frontend
pnpm run test:visual
pnpm exec vitest run
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：Playwright 2 个项目通过；Vitest 67 个测试文件、531 个测试通过；typecheck、lint、build
均通过。生产 build 仅生成根应用入口，未包含视觉 fixture。
