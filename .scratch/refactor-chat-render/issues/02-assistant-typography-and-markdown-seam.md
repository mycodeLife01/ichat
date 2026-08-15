# 深化 Markdown seam 并对齐助手排版

Type: refactor

Status: completed

Blocked by: 01

## What to build

保留 `MarkdownProps` 和三个现有调用入口，把 ChatGPT 风格的正文排版收进 Markdown 深模块。新增助手专用内容列与 scoped typography，使最终消息、流式正文和公开分享使用相同的宽度、标题、段落、列表、引用、分隔线和行内代码规则。

本 ticket 只处理内容列和基础排版；代码块 toolbar/高亮属于 ticket 03，表格/链接交互属于 ticket 04。

## Implementation notes

- 在 `global.css` 增加 `--assistant-content-width: 768px`，不要修改现有 `--reading-width: 820px`。
- 在 `Message.tsx`、`StreamingMessage.tsx` 和 `SharePage.tsx` 的助手内容容器应用同一个 scoped class/utility；来源、附件和动作与正文列对齐。
- `Markdown.tsx` wrapper 保留 `.body.md` 语义钩子，并增加明确的 `.assistant-markdown` 作用域。
- 桌面首轮 token 使用 PRD 的 768px、16/26 和 H1/H2/H3 数值；移动端使用 ticket 01 的实测值。
- 清理 `.md` 规则之间互相覆盖的字号/line-height，确保根、段落、列表、引用和表格不会各自漂移。
- inline code 去掉当前可见 1px 边框，保留浅背景、4px 圆角和可读 padding。
- blockquote 取消当前 40px 双侧 margin，按参考使用左侧线条和正文内缩进。
- 不修改 Markdown plugin 顺序、math schema、citation 插件或 sanitize 配置。

## Reasoning freeze

- 不修改 `ThinkingBlock.tsx`、`reasoningPreview.ts` 或 `runs/state.ts`。
- 若为了列宽需要改 `StreamingMessage` wrapper，只能调整外部布局 class；不得改 `thinking`、`hasReasoning`、`showThinking`、label 或 props 计算。
- 现有 reasoning 行为测试不得删除、跳过或把精确行为断言改成模糊 snapshot。

## Acceptance criteria

- [x] 三个助手入口共享一个 768px 桌面内容列，Composer 和非助手页面仍保持原宽度。
- [x] 正文、H1/H2/H3、段落间距、列表嵌套、blockquote、hr 和 inline code 与 reference metrics 一致。
- [x] H4–H6 仍有明确层级，GFM task list 不被 Tailwind preflight 去样式。
- [x] 390px 下正文列使用可用宽度且无页面水平 overflow，长 URL 能换行。
- [x] KaTeX、citation、raw HTML 拒绝和货币 `$5` 行为保持不变。
- [x] 最终、流式和分享页的相同基础 Markdown 产生一致语义 DOM。
- [x] reasoning 折叠、展开、preview、DeepSeek 自动展开和正文 handoff 的既有断言全部原样通过。
- [x] ticket 01 的诊断截图已更新为本 ticket 结果，但尚不固化为最终 golden。

## Verification

```bash
cd frontend
pnpm exec vitest run \
  src/messages/Markdown.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/StreamingMessage.test.tsx \
  src/messages/ThinkingBlock.test.tsx \
  src/messages/SharePage.test.tsx \
  src/runs/state.test.ts
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Comments

- 2026-08-15：采用现有 Markdown 作为唯一外部 seam；不实施参考报告中的 `AssistantRenderModel` 和三个 Adapter。
- 2026-08-15：完成 `--assistant-content-width: 768px`、final/streaming/share 共用的 `assistant-content` 列，以及 `.assistant-markdown.body.md` scoped typography。桌面与 390px Playwright 均校验正文、H1–H6、段落、列表、blockquote、hr、inline code 和页面 overflow，并更新 gitignored 诊断截图；未固化 golden。验证结果：定向 Vitest 6 files / 87 tests、完整 Vitest 67 files / 534 tests、Playwright 2 passed、typecheck、lint、build 均通过。reasoning freeze 文件未修改。
