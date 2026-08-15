# 助手排版与 Markdown seam 交接

- 日期：2026-08-15
- 分支：`refactor/ai-chat-render`
- 范围：`.scratch/refactor-chat-render/` 的 ticket 02；下一步为 ticket 03。

## 当前状态

Ticket 02 已完成，PRD frontier 已推进到 ticket 03。验收范围、设计决策和完成记录以
`.scratch/refactor-chat-render/PRD.md` 与
`.scratch/refactor-chat-render/issues/02-assistant-typography-and-markdown-seam.md` 为准；本交接只记录继续工作所需的上下文。

最终消息、流式正文和公开分享仍共同调用 `frontend/src/messages/Markdown.tsx`。本次没有引入
`AssistantRenderModel`、后端展示契约或新的调用方 props。

## 本次落地

- `frontend/src/styles/global.css` 新增独立的 `--assistant-content-width: 768px`，保留
  `--reading-width: 820px`；助手正文采用固定参考的系统字体栈、16/26 正文、H1–H6、列表、
  GFM task list、blockquote、hr 和 inline code 规则。
- `frontend/src/ui/classes.ts` 提供共用 `assistantContentColumn`；`Message.tsx`、
  `StreamingMessage.tsx` 和 `SharePage.tsx` 用它统一正文、来源、附件及动作的列宽和对齐。
- `Markdown.tsx` 保留 `.body.md` 钩子并增加 `.assistant-markdown` scope；Markdown plugin、
  sanitize、KaTeX 和 citation pipeline 顺序未改。
- `frontend/tests/visual/assistant-rendering.visual.ts` 现在同时校验宽度 token、正文与标题 computed
  style、引用、列表、分隔线、inline code 和页面 overflow。桌面与 390px 诊断截图已更新到
  gitignored 的 `frontend/output/playwright/results/`，仍未固化 golden；golden 继续由 ticket 06 拥有。

## 冻结边界

`ThinkingBlock.tsx`、`reasoningPreview.ts` 和 `runs/state.ts` 均未修改。reasoning 的默认折叠、
DeepSeek 自动展开、preview、正文 handoff、恢复和终态语义继续由现有测试保护。

代码块仍是 `Markdown.tsx` 内的旧 `Pre` renderer；语言 header、高亮、复制失败语义和独立源码
scroller 均属于 ticket 03。当前失败 Clipboard fixture 会暴露旧 renderer 仍错误显示成功勾选，
这是下一 ticket 的预期缺口，不应通过 fixture CSS 掩盖。移动宽表格目前会压缩单元格但不撑宽
页面，专用 table scroller 与复制动作属于 ticket 04。

## 验证记录

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run \
  src/messages/Markdown.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/StreamingMessage.test.tsx \
  src/messages/ThinkingBlock.test.tsx \
  src/messages/SharePage.test.tsx \
  src/runs/state.test.ts
pnpm exec vitest run
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：定向测试 6 files / 87 tests，完整测试 67 files / 534 tests，Playwright 桌面与移动 2 passed；
typecheck、lint 和 build 通过。Ticket 03 增加高亮依赖前的 production baseline 为：JS
`869.04 kB`（gzip `266.20 kB`），CSS `89.83 kB`（gzip `20.87 kB`）。

## 下一步

从 `.scratch/refactor-chat-render/issues/03-chatgpt-code-blocks.md` 开始。先固定 Markdown 公共 seam
下的语言归一化、原始源码复制成功/失败和未知语言降级，再替换私有 code renderer；不要向三个
调用入口增加 code-specific props，也不要提前实现 ticket 04 的表格/链接交互。

## Suggested skills

- `$tdd`：按语言归一化、复制语义和 code surface 三个可观察 seam 逐个执行 RED → GREEN。
- `$playwright`：复核桌面/390px 的 header、长行独立滚动、复制成功/失败和未闭合 fence。
