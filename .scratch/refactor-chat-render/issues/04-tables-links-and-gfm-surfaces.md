# 实现表格、链接与 GFM rich surface

Type: feature

Status: ready-for-agent

Blocked by: 03

## What to build

补齐代码块之外最显著的 ChatGPT Markdown surface：为表格增加独立卡片/滚动容器和复制能力，为链接增加安全的站内/站外行为，并完成任务列表、嵌套列表和引用等 GFM 细节的像素对齐。

## Implementation notes

### TableBlock

- 新建 Markdown 私有实现 `markdown/TableBlock.tsx`，由 ReactMarkdown 的 `table` renderer 使用。
- wrapper 使用 `min-width: 0`；只有 table viewport `overflow-x: auto`，Markdown root 和页面不横向滚动。
- 复制按钮从真实 table DOM 或纯 serializer 生成 TSV，保留行列顺序与可见文本；不得复制 toolbar 文案。
- 可滚动区域具备可访问名称；确有横向 overflow 时键盘可以聚焦和滚动。
- header、cell、border、背景、字号、padding、圆角和前后间距按参考 fixture 微调。

### MarkdownLink

- 新建 Markdown 私有实现 `markdown/MarkdownLink.tsx`。
- `http:`/`https:` 使用新 browsing context，并设置 `rel="noopener noreferrer"`。
- 相对 URL、hash 和项目认可的站内 URL 保持当前页导航语义。
- sanitize 丢弃的危险协议不得由 renderer 重新构造；不得使用 raw HTML。
- 长链接文字可以换行，不让内容列溢出。

### GFM details

- 对齐 task checkbox 的尺寸、禁用态、baseline 和列表缩进，不把 disabled checkbox 变成可交互业务控件。
- 覆盖嵌套有序/无序列表、tight/loose list、blockquote 内段落、粗斜体和删除线组合。

## Acceptance criteria

- [ ] 宽表格只在自身 viewport 横向滚动，桌面和 390px 页面都无横向 overflow。
- [ ] 表格复制成功/失败均有反馈和测试，TSV 对表头、空单元格、中英文和多行文本有确定行为。
- [ ] 多张表各自拥有独立 toolbar、copy state 和 scroll position。
- [ ] 外链、相对链接、hash、缺失 href 和危险协议的行为均有测试；外链不会接管当前 iChat 页面。
- [ ] task list、嵌套列表和 blockquote 的视觉与 reference fixture 一致，并保持正确 HTML 语义。
- [ ] citation chip、普通 `[n]`、code/math 内 `[n]` 的既有行为不变。
- [ ] final、streaming 和 share 均复用相同 TableBlock/MarkdownLink，没有复制实现。
- [ ] ticket 01 的桌面/移动诊断场景全部通过。

## Verification

```bash
cd frontend
pnpm exec vitest run \
  src/messages/Markdown.test.tsx \
  src/messages/Citation.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/SharePage.test.tsx
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

## Comments

- 2026-08-15：表格和链接仍是 Markdown 的私有 element renderer，不扩展消息/后端数据模型。
