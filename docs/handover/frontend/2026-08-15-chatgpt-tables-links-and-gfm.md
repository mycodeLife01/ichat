# ChatGPT 风格表格、链接与 GFM 交接

日期：2026-08-15

分支：`refactor/ai-chat-render`

范围：`.scratch/refactor-chat-render/issues/04-tables-links-and-gfm-surfaces.md`

下一步：ticket 05（流式 prefix 与长回复性能）

## 当前状态

Ticket 04 已完成。final、streaming 和 share 三个入口仍复用原有 `Markdown` Interface；表格与链接能力收敛在 `frontend/src/messages/markdown/` 私有模块，没有增加消息 props、展示模型或后端契约。

表格现在具备：

- 覆盖在表头右上角的 28px 图标 toolbar 与具名 `region` viewport，只有 viewport 持有横向滚动；
- `min-width: 0` 外壳和 intrinsic table 宽度，宽列不会撑开 Markdown 根节点或页面；
- 表头 `14px / 16px`、正文 cell `14px / 24px` 及参考 padding、分隔线、透明背景和 0 圆角；
- 基于真实 table DOM 的 TSV 复制，不会包含 toolbar 文案；
- Clipboard promise 成功后才显示成功态，失败时保留可重试按钮并提供可访问反馈；
- 每张表独立拥有复制状态和滚动位置，横向滚动不移动 toolbar。

TSV 规则固定为：行以换行分隔、单元格以 tab 分隔、空单元格保留空字段；`<br>` 作为单元格内换行。含换行、tab 或双引号的字段使用双引号包裹，内部双引号写成两个双引号，因此中英文、多行和引号内容均有确定、可逆的结果。

链接现在具备：

- 跨源 `http:` / `https:` 使用 `target="_blank"` 与 `rel="noopener noreferrer"`；
- 相对 URL、hash、空目标和同源绝对 URL 保持当前 browsing context；
- sanitize 删除的危险 `href` 不会由 renderer 重建，也未启用 raw HTML；
- 长链接显式允许换行，不会撑破助手内容列。

GFM 回归固定了 disabled task checkbox 的尺寸、baseline 和缩进，并覆盖嵌套有序/无序列表、tight/loose list、blockquote 多段落、粗斜体与删除线组合。citation、code、math 的既有隔离语义未改。

## 实现边界

`Markdown.tsx` 只把 ReactMarkdown 的 `table` 与 `a` renderer 指向私有 `TableBlock` 和 `MarkdownLink`。TSV 纯转换位于 `tableTsv.ts`，Clipboard 能力继续复用 `copyText.ts`。

以下边界保持冻结：

- math normalize、streaming clamp、remark GFM/math、sanitize、KaTeX、citation 和 React renderer 的 pipeline 顺序；
- raw HTML 禁用、危险协议过滤，以及 code/pre/math 内 citation marker 不激活；
- ticket 03 的 `CodeBlock` 实现和按需高亮 chunk；
- `ThinkingBlock`、reasoning、SSE/recovery、消息事实源与公开分享授权语义；
- `MarkdownProps` 及 final、streaming、share 的入口结构。

## Bundle 记录

production build 相对 ticket 04 开始前（ticket 03 完成态）：

| Asset | Baseline | 当前 | Delta |
|---|---:|---:|---:|
| 主 JS | 873.52 kB / gzip 267.58 kB | 875.21 kB / gzip 268.08 kB | +1.69 kB / gzip +0.50 kB |
| CSS | 92.14 kB / gzip 21.38 kB | 93.59 kB / gzip 21.63 kB | +1.45 kB / gzip +0.25 kB |
| 按需 syntax chunk | 86.07 kB / gzip 26.78 kB | 86.07 kB / gzip 26.78 kB | 无变化 |

本 ticket 未增加 runtime dependency。

## 验证结果

在 `frontend/` 下通过：

```bash
pnpm exec vitest run \
  src/messages/Markdown.test.tsx \
  src/messages/markdown/tableTsv.test.ts \
  src/messages/Citation.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/StreamingMessage.test.tsx \
  src/messages/SharePage.test.tsx
pnpm exec vitest run
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：

- targeted Vitest：6 files / 86 tests；
- 完整 Vitest：70 files / 579 tests；
- Playwright visual fixture：desktop 1440px 与 mobile 390px 共 2 tests；
- lint、typecheck、production build 全部通过；
- 浏览器验证宽表格自身滚动、toolbar 固定、逐表 copy/scroll 状态、复制成功/失败、外链打开新页面且原 fixture URL 不变；
- 桌面和 390px 下页面均无水平 overflow，长链接正常换行；
- CLI 语义快照确认 task checkbox 为 checked/disabled 真实控件，嵌套列表、两张最终表格和流式未闭合表格均保持正确语义。fixture 仍有既存的 `/favicon.ico` 404，不影响渲染验收。

## Ticket 05 注意事项

下一张 ticket 是 `.scratch/refactor-chat-render/issues/05-streaming-prefix-and-performance.md`。先测量完整 prefix matrix 与 10k/20k/50k 浏览器成本；只有超过性能门时才引入最小视图 batching。

Ticket 05 不得改 Run reducer、SSE cursor、恢复语义或 `ThinkingBlock`，也不得按空行切 Markdown 或自研增量 AST。后续 delta 还需验证已闭合表格的横向滚动与复制状态不会无故重置。

Ticket 06 才会批准并固化最终 golden baseline；当前视觉截图仍是诊断证据。

## 建议 skills

- `$tdd`：逐个 prefix 写可观察行为失败测试，再推进最小实现。
- `$playwright`：在真实浏览器记录 long task、输入响应和已闭合 rich block 的交互状态。
