# ChatGPT 风格助手回复渲染最终交接

日期：2026-08-15

分支：`refactor/ai-chat-render`

范围：`.scratch/refactor-chat-render/` tickets 01–06

状态：已完成；desktop/mobile golden 已获用户批准

## 最终结论

iChat 当前支持的助手正文 surface 已按 2026-08-15 固定的 ChatGPT Windows Chrome
参考完成对齐。历史最终消息、进行中流式消息和公开分享继续复用现有
`frontend/src/messages/Markdown.tsx` Interface，没有增加新的展示模型或后端契约。

本 feature 的边界已经冻结：

- `ThinkingBlock`、reasoning preview、DeepSeek 自动展开、正文 handoff、恢复与终态隐藏逻辑
  保持原状；
- 未引入 `AssistantRenderModel`、Display Part、reasoning summary、工具活动列表或新的消息 schema；
- 未实现 Mermaid、chart、Artifact、mini app 或代码执行；
- 未修改 SSE、Run reducer、数据库、分享授权、附件授权或 provider transcript；
- 保留全量 Markdown parse。实测典型流式 trace 和两类 20k 压力均不需要 batching。

## 已交付行为

### 共享 Markdown surface

三个生产入口共同调用 `Markdown`：

```text
Message（final） ─────────┐
StreamingMessage（live） ├─> Markdown Interface
SharePage（public share）┘
```

`Markdown` 内部固定使用以下顺序：

```text
math delimiter normalize
→ streaming math clamp
→ remark GFM / math
→ rehype sanitize
→ rehype KaTeX
→ rehype citations
→ React element renderers
```

原始 HTML 仍未启用。代码、表格和链接 renderer 只消费 sanitize 后的 parsed node；危险
href 被移除后不会由 renderer 重建，也没有使用 `dangerouslySetInnerHTML`。

### 几何与排版

- 助手桌面内容列使用独立的 `--assistant-content-width: 768px`，正文为 `16px / 26px`；
- H1/H2/H3 分别为 `24/32`、`20/28`、`18/28`，字重 600；H4–H6、段落、列表、
  blockquote、分隔线和 inline code 均按固定 computed-style 记录验收；
- final、streaming、share 的正文、来源、附件和动作使用同一内容列；
- 390px 页面本身没有水平 overflow；长代码和宽表格只在自己的 viewport 横向滚动；
- ticket 06 的真实浏览器对比发现 share 外壳曾比另外两个入口窄 4px。原因是项目根字号为
  15px，`4rem` 只等于 60px，无法覆盖两侧 `px-8` 的 64px gutter。现已改为
  `calc(var(--assistant-content-width) + 64px)`，三入口桌面正文均为 768px。

### Rich surface 与流式边界

- 代码块提供语言 header、按需 Prism token 高亮、未知语言 plaintext 降级、复制成功/失败
  反馈和独立横向滚动；复制值保持原始源码，不读取高亮 DOM；
- 表格提供右上角 overlay 复制按钮、逐表复制状态、DOM-to-TSV 和独立横向滚动；
- 跨源 HTTP(S) 链接使用 `_blank` 与 `noopener noreferrer`，相对链接保留站内语义；
- GFM 任务列表、嵌套列表、引用、删除线、KaTeX 和 citation 继续受回归保护；
- 14 组累计 streaming prefix 覆盖 emphasis、link、fence、list、table、math、citation、
  中英文段落与危险 raw HTML；
- 未闭合 fenced code 内的 `$$` 不再被 math clamp 截断，`\[...\]` 稳定生成 block math；
- 已闭合 code/table 接收后续 delta 时保持组件节点、复制态和自身滚动位置。

## 主要文件

生产代码：

- `frontend/src/messages/Markdown.tsx`、`mathDelimiters.ts`；
- `frontend/src/messages/markdown/CodeBlock.tsx`、`TableBlock.tsx`、`MarkdownLink.tsx`；
- `frontend/src/messages/markdown/codeLanguage.ts`、`copyText.ts`、`tableTsv.ts`；
- `frontend/src/messages/Message.tsx`、`StreamingMessage.tsx`、`SharePage.tsx`；
- `frontend/src/styles/global.css`、`frontend/src/ui/classes.ts`。

测试与证据：

- `frontend/src/messages/Markdown.test.tsx`、`Markdown.streaming.test.tsx` 及三个入口测试；
- `frontend/src/test/streamingMarkdownFixtures.ts`、`longMarkdownFixtures.ts`；
- `frontend/tests/visual/assistant-rendering.*`；
- `frontend/tests/visual/assistant-rendering-performance.*`；
- `frontend/playwright.config.ts`；
- `frontend/tests/visual/assistant-rendering.visual.ts-snapshots/`。

## 依赖与构建体积

本 feature 新增：

- runtime：`prism-react-renderer@2.4.1`；
- dev：`@playwright/test@^1.62.1` 和 `pnpm run test:visual`。

ticket 06 没有再增加依赖。现有 `react-markdown`、`remark-gfm`、`remark-math`、
`rehype-sanitize`、`rehype-katex` 继续组成 parser/security pipeline。

最终 production build：

| 产物 | 体积 | gzip |
|---|---:|---:|
| 主 JS | 875.22 kB | 268.08 kB |
| 按需 syntax chunk | 86.07 kB | 26.78 kB |
| CSS | 93.59 kB | 21.63 kB |

高亮器是独立动态 chunk；未知语言和 chunk 加载失败时仍保留可读、可复制的 plaintext。

## 性能证据

环境为 Windows Headless Chromium `151.0.7922.34`、`1440 × 900`、DPR 1、浅色、
reduced motion。完整方法见
`docs/handover/frontend/2026-08-15-chatgpt-streaming-prefix-and-performance.md`。

| 场景 | 字符 / 更新 | parse+render p95 / max | update→commit p95 / max | long task max / >100ms | heap peak delta |
|---|---:|---:|---:|---:|---:|
| 静态 rich Markdown | 10k / 1 | 49.8 / 49.8ms | 50.9 / 50.9ms | 50ms / 0 | 12.12MB |
| 静态 rich Markdown | 20k / 1 | 54.6 / 54.6ms | 56.2 / 56.2ms | 56ms / 0 | 14.39MB |
| 静态 rich Markdown | 50k / 1 | 118.1 / 118.1ms | 121.9 / 121.9ms | 121ms / 1 | 26.79MB |
| 脱敏真实累计 trace | 174 / 128 | 0.5 / 0.9ms | 1.0 / 1.4ms | 0 / 0 | 6.63MB |
| 持续未闭合 code fence | 20k / 128 | 10.8 / 11.7ms | 14.0 / 15.3ms | 0 / 0 | 43.76MB |
| 多个闭合 rich block | 20k / 128 | 36.4 / 42.4ms | 43.3 / 50.2ms | 0 / 0 | 50.69MB |

真实 trace 期间的 controlled-input commit p95/max 为 `0.3/0.7ms`，Event Timing p95 为
`24ms`。50k 静态冷渲染的 121ms 是已记录的极长 final 边界，不是典型流式门；因此没有用
batching 增加 terminal flush、恢复和替换复杂度。

## 视觉证据与 golden

在线参考环境为 Windows Chrome `151.0.7922.138`、100% zoom、浅色、DPR 1；桌面参考
viewport 为 `2560 × 1249`，移动补测为 `390 × 844`。在线页面只用于点时测量，不进入 CI，
不保存 URL、Cookie、登录态或真实对话截图。

本地真实浏览器验收覆盖：

- final、streaming、share 相同 Markdown 的语义签名、宽度与 computed style；
- failed/cancelled/recovered partial；
- ThinkingBlock 折叠/展开；
- code/table hover、focus-visible、成功/失败复制和独立横向滚动；
- desktop `1440 × 900` 与 mobile `390 × 844` 页面 overflow。

用户于 2026-08-15 批准以下 Windows Chromium 全页 golden：

| Baseline | 文件 | 大小 |
|---|---|---:|
| Desktop | `assistant-rendering-golden-desktop-chrome-win32.png` | 507,343 bytes |
| Mobile | `assistant-rendering-golden-mobile-chrome-win32.png` | 451,285 bytes |

文件位于
`frontend/tests/visual/assistant-rendering.visual.ts-snapshots/`。截图不使用宽泛 mask；写入前会
等待复制反馈计时器复位、清除 hover/focus 并回到顶部。Windows 以外平台继续运行同一语义、
交互和几何断言，但不声称不同字体栅格逐像素一致。性能压力页是数值门禁，不进入 golden。

## 已接受偏差

1. ChatGPT 点时参考的页面 canvas 为 `rgb(252, 252, 252)`；iChat 既有 host canvas 为
   `#fbfbfa`。助手 surface 本身保持透明，正文几何、排版与 rich surface 已对齐。用户批准
   保留应用级 canvas 差异，不为本 feature 改全局页面品牌背景。
2. 在线只读测量接口没有稳定提取 390px 下代码完整 toolbar 间距和表格复制按钮相对坐标。
   已明确保留这一证据边界，并由用户批准的 390px iChat 实际截图作为后续本地事实；没有用
   桌面值补猜或宣称其来自在线测量。

## 最终验证

在 `frontend/` 下：

```bash
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
pnpm run test:visual
```

然后在仓库根目录：

```bash
git diff --check
```

最终结果：完整 Vitest `72 files / 613 tests`；Playwright desktop visual、mobile visual 和
desktop performance `3 passed`，mobile performance 按固定证据环境 `1 skipped`；lint、
typecheck、production build、无更新参数的 golden 比较与 `git diff --check` 全部通过。

## 回滚

本 feature 没有数据库、API、SSE 或部署迁移，回滚不需要数据修复。

1. 先回退视觉 fixture、golden、Playwright 配置和对应测试；这些不影响 production runtime。
2. 再按入口与样式一起回退 `Message`、`StreamingMessage`、`SharePage`、助手宽度 token 和
   scoped `.assistant-markdown` 规则，避免只回退一半造成三入口漂移。
3. 若回退代码/表格/链接 renderer，再恢复 `Markdown.tsx` 的 element mapping，并同时移除其
   私有 helper 与测试。
4. 只有在所有 runtime import 已移除后才删除 `prism-react-renderer` 并更新
   `pnpm-lock.yaml`；`@playwright/test` 是否保留可独立决定。

已有 feature 提交为 `db6815f`、`731b0ac`、`3453f88`、`c851255`、`7680964`；若用 Git
回滚，应连同 ticket 06 的最终提交按逆序逐个 revert，不能用 destructive reset 覆盖其他工作。
