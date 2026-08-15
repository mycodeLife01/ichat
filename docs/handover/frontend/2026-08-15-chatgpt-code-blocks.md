# ChatGPT 风格代码块交接

日期：2026-08-15

分支：`refactor/ai-chat-render`

范围：`.scratch/refactor-chat-render/issues/03-chatgpt-code-blocks.md`

下一步：ticket 04（表格、链接与 GFM rich surface）

## 当前状态

Ticket 03 已完成。final、streaming 和 share 三个入口仍复用原有 `Markdown` Interface；代码块能力完全收敛在 `frontend/src/messages/markdown/` 私有模块，调用方没有新增 code-specific props。

代码块现在具备：

- 独立语言 header、复制 action、圆角浅色 surface 和可聚焦源码 viewport；
- 常见 fenced language alias 的规范 label，未知语言保留原始 label 并安全降级 plaintext；
- 使用 React token nodes 的语法着色，不使用 `dangerouslySetInnerHTML`；
- 忠实保留内部空白、空行和长行，仅移除 ReactMarkdown 为 fenced code 带入的一个末尾换行；
- Clipboard promise resolve 后才显示成功态，reject/缺失时保留可重试状态并给出可访问反馈；
- 重复点击的竞态保护和 unmount timer 清理；
- 200+ 字符长行只滚动源码 viewport，header 与正文列保持原位；
- 无语言、未知 grammar 和流式未闭合 fence 均使用同一个稳定 surface，不抛错或泄露错误栈。

## 实现边界

`Markdown.tsx` 只把 ReactMarkdown 的 `pre` renderer 指向私有 `CodeBlock`。语言解析位于 `codeLanguage.ts`，Clipboard 能力位于 `copyText.ts`；这些模块不是新的业务 Interface。

语法高亮依赖在代码块实际挂载后动态加载。若 chunk 或 grammar 不可用，已经渲染的原始源码仍可阅读、选择和复制。没有引入 CodeMirror、代码执行、行号、编辑器状态或额外全语言扩展包。

以下边界保持冻结：

- math normalize、streaming clamp、remark GFM/math、sanitize、KaTeX、citation 和 React renderer 的 pipeline 顺序；
- raw HTML 禁用、危险协议过滤，以及 code/pre/math 内 citation marker 不激活；
- `ThinkingBlock`、reasoning state、SSE/recovery、消息事实源和公开分享授权语义；
- `MarkdownProps` 及 final、streaming、share 的入口结构。

## Bundle 记录

production build 相对 ticket 03 开始前 baseline：

| Asset | Baseline | 当前 | Delta |
|---|---:|---:|---:|
| 主 JS | 869.04 kB / gzip 266.20 kB | 873.52 kB / gzip 267.58 kB | +4.48 kB / gzip +1.38 kB |
| CSS | 89.83 kB / gzip 20.87 kB | 92.14 kB / gzip 21.38 kB | +2.31 kB / gzip +0.51 kB |
| 按需 syntax chunk | — | 86.07 kB / gzip 26.78 kB | 仅代码块挂载后加载 |

静态导入高亮器曾使主 JS 达到 958.40 kB / gzip 294.31 kB，因此最终实现保留按需 chunk，避免没有代码块的回复承担这部分下载和解析成本。

## 验证结果

在 `frontend/` 下通过：

```bash
pnpm exec vitest run src/messages/Markdown.test.tsx src/messages/Citation.test.tsx src/messages/markdown/codeLanguage.test.ts src/messages/markdown/copyText.test.ts
pnpm exec vitest run
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：

- targeted Vitest：4 files / 52 tests；
- 完整 Vitest：69 files / 568 tests；
- Playwright visual fixture：desktop 1440px 与 mobile 390px 共 2 tests；
- lint、typecheck、production build 全部通过；
- 真实浏览器确认语言 header、文本选择、源码 viewport 横向滚动、header 固定、复制失败可重试和流式未闭合 fence；
- 390px 下页面 `scrollWidth === clientWidth === 390`，没有页面级水平 overflow。

## Ticket 04 注意事项

下一张 ticket 是 `.scratch/refactor-chat-render/issues/04-tables-links-and-gfm-surfaces.md`。表格 wrapper、TSV 复制和外链策略继续作为 Markdown 私有 renderer 实现，并保持当前代码块 renderer 不变。可以复用 `copyText.ts` 的成功语义，但不要把表格状态或 props 塞进 `CodeBlock`，也不要改变现有 parser/security pipeline。

Ticket 06 才会批准并固化最终 golden baseline；当前 visual fixture 的截图仍是诊断证据，不应提前当成跨环境像素事实。

## 建议 skills

- `$tdd`：先以 `Markdown` 的可观察 DOM、链接安全属性、表格滚动和 TSV 复制行为写失败测试，再实现 Ticket 04。
- `$playwright`：验证 desktop/390px 表格独立横向滚动、toolbar 稳定、链接交互与页面无水平 overflow。
