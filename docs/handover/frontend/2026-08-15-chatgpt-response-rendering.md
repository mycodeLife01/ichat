# ChatGPT 风格助手回复渲染最终交接

日期：2026-08-15

复核日期：2026-08-16

分支：`refactor/ai-chat-render`

范围：`.scratch/refactor-chat-render/` tickets 01–06

状态：已完成；2026-08-16 已用用户 Chrome 中的同内容双页签重新逐段复核并更新
desktop/mobile golden

## 最终结论

iChat 当前支持的助手正文 surface 已按 2026-08-15 固定的 ChatGPT Windows Chrome
参考完成对齐。2026-08-16 的复核把段落节奏、软换行、列表与任务项、引用、链接、代码块、
表格、图标和各 surface 间距重新按当前 ChatGPT 页面校准。历史最终消息、进行中流式消息和公开分享继续复用现有
`frontend/src/messages/Markdown.tsx` Interface，没有增加新的展示模型或后端契约。

本 feature 的边界已经冻结：

- `ThinkingBlock`、reasoning preview、DeepSeek 自动展开、正文 handoff、恢复与终态隐藏逻辑
  保持原状；
- 未引入 `AssistantRenderModel`、Display Part、reasoning summary、工具活动列表或新的消息 schema；
- 未实现 Mermaid、chart、Artifact、mini app 或 Python 代码执行；HTML fenced code 仅增加隔离的
  静态 preview，不执行脚本，也不改变 Markdown raw HTML 的安全边界；
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
→ remark GFM / breaks / math
→ rehype sanitize
→ rehype KaTeX
→ rehype citations
→ React element renderers
```

原始 HTML 仍未启用。代码、表格和链接 renderer 只消费 sanitize 后的 parsed node；危险
href 被移除后不会由 renderer 重建，也没有使用 `dangerouslySetInnerHTML`。HTML fenced code
的预览值只进入空权限 `sandbox` 的 `iframe srcdoc`，与正文 DOM、脚本和同源权限隔离。

### 几何与排版

- 助手桌面内容列使用独立的 `--assistant-content-width: 768px`，正文为 `16px / 26px`；
- H1/H2/H3 分别为 `24/32`、`20/28`、`18/28`，字重 600；H4–H6、段落、列表、
  blockquote、分隔线和 inline code 均按固定 computed-style 记录验收；
- 普通段落按上下文使用 ChatGPT 的 `16px`、`8px` 和末尾 `4px` 节奏；单个源码换行通过
  `remark-breaks` 生成可见 `<br>`，不再被 CommonMark 合并成空格；
- 列表项本身无额外纵向间距，marker 为正文色粗体；任务 checkbox 为 `16 × 16px`，checked
  状态使用同色填充与固定 check path；blockquote 使用 `4px`、15% 黑色、2px 圆角的伪元素竖线；
- final、streaming、share 的正文、来源、附件和动作使用同一内容列；
- 390px 页面本身没有水平 overflow；长代码和宽表格只在自己的 viewport 横向滚动；
- ticket 06 的真实浏览器对比发现 share 外壳曾比另外两个入口窄 4px。原因是项目根字号为
  15px，`4rem` 只等于 60px，无法覆盖两侧 `px-8` 的 64px gutter。现已改为
  `calc(var(--assistant-content-width) + 64px)`，三入口桌面正文均为 768px。

### Rich surface 与流式边界

- 有语言的代码块使用 `48px` header、16px ChatGPT code glyph 和 `36 × 36px` 圆形 copy
  control；无语言及显式 plain/text fence 隐藏 header，只保留覆盖式 copy control；
- Python block 额外显示与 ChatGPT 相同的 copy + “运行”工具栏（动作组约 `123.333 × 36px`）；
  当前没有安全的执行后端，因此按钮通过 `aria-disabled` 明确为仅视觉 affordance；
- HTML block 使用同一 SVG path 的专属 label glyph、`74 × 36px` code/preview 切换组和
  `36 × 36px` copy/fullscreen control；preview 为 `16:9` 的空权限 sandboxed iframe，切换前后
  外壳、header 背景和控件位置与 ChatGPT 相同；
- Python、JavaScript/JSX、TypeScript/TSX、JSON、YAML、HTML 和 CSS 使用按语言异步加载的
  Lezer parser；SQL 与 Bash 使用只读轻量词法分类，其他已知语言保留 Prism fallback。参考样例中
  identifier/property、JSON punctuation、Bash flag、SQL operator、HTML attribute 与 CSS value 的
  token role 和颜色已逐项与 ChatGPT 对齐；
- 代码块继续提供未知语言 plaintext 降级、复制成功/失败反馈和独立横向滚动；代码正文为
  `14px / 20px`，桌面 padding `0 16px 12px 20px`、390px padding
  `0 12px 12px 16px`，复制值保持原始源码，不读取高亮 DOM；
- 表格扩展到 thread viewport，内部表格仍与 768px 正文列对齐；复制按钮只在 hover/focus-within
  显示，并随表格内容横向滚动。表格继续使用逐表复制状态、DOM-to-TSV 和独立 scroller；
- 跨源 HTTP(S) 链接使用 `_new` 与 `noopener`，文字为正文色点状下划线，并附带当前 ChatGPT
  的 12px external-link glyph；相对链接保留站内语义；
- GFM 任务列表、嵌套列表、引用、删除线、KaTeX 和 citation 继续受回归保护；
- 14 组累计 streaming prefix 覆盖 emphasis、link、fence、list、table、math、citation、
  中英文段落与危险 raw HTML；
- 未闭合 fenced code 内的 `$$` 不再被 math clamp 截断，`\[...\]` 稳定生成 block math；
- 已闭合 code/table 接收后续 delta 时保持组件节点、复制态和自身滚动位置。

## 主要文件

生产代码：

- `frontend/src/messages/Markdown.tsx`、`mathDelimiters.ts`；
- `frontend/src/messages/markdown/CodeBlock.tsx`、`TableBlock.tsx`、`MarkdownLink.tsx`；
- `frontend/src/messages/markdown/codeLanguage.ts`、`codeHighlight.ts`、`copyText.ts`、`tableTsv.ts`；
- `frontend/src/messages/Message.tsx`、`StreamingMessage.tsx`、`SharePage.tsx`；
- `frontend/src/styles/global.css`、`frontend/src/ui/classes.ts`、`frontend/src/ui/icons.tsx`。

测试与证据：

- `frontend/src/messages/Markdown.test.tsx`、`Markdown.streaming.test.tsx` 及三个入口测试；
- `frontend/src/test/streamingMarkdownFixtures.ts`、`longMarkdownFixtures.ts`；
- `frontend/tests/visual/assistant-rendering.*`；
- `frontend/tests/visual/assistant-rendering-performance.*`；
- `frontend/playwright.config.ts`；
- `frontend/tests/visual/assistant-rendering.visual.ts-snapshots/`。

## 依赖与构建体积

本 feature 新增：

- runtime：`remark-breaks@^4.0.0`、`@lezer/highlight@1.2.3`，以及 Python、JavaScript、
  JSON、HTML、CSS、YAML 的 `@lezer/*` parser；`prism-react-renderer@2.4.1` 仅作为其他已知
  语言的 fallback；
- dev：`@playwright/test@^1.62.1` 和 `pnpm run test:visual`。

现有 `react-markdown`、`remark-gfm`、`remark-math`、`rehype-sanitize`、`rehype-katex`
继续组成 parser/security pipeline。只读高亮没有引入 CodeMirror editor、state、autocomplete
或 language support 包。

最终 production build：

| 产物 | 体积 | gzip |
|---|---:|---:|
| 主 JS | 880.91 kB | 269.60 kB |
| 高亮协调 chunk | 39.97 kB | 14.17 kB |
| 单语言/fallback chunks | 1.73–83.47 kB | 1.10–30.70 kB |
| CSS | 99.71 kB | 22.98 kB |

高亮协调器和每个 parser 都是独立动态 chunk；一个普通代码块不会下载所有语言。未知语言和
任一 chunk 加载失败时仍保留可读、可复制的 plaintext。

## 性能证据

环境为 Windows Headless Chromium `151.0.7922.34`、`1440 × 900`、DPR 1、浅色、
reduced motion。完整方法见
`docs/handover/frontend/2026-08-15-chatgpt-streaming-prefix-and-performance.md`。

| 场景 | 字符 / 更新 | parse+render p95 / max | update→commit p95 / max | long task max / >100ms | heap peak delta |
|---|---:|---:|---:|---:|---:|
| 静态 rich Markdown | 10k / 1 | 51.1 / 51.1ms | 52.5 / 52.5ms | 52ms / 0 | 5.96MB |
| 静态 rich Markdown | 20k / 1 | 64.5 / 64.5ms | 66.2 / 66.2ms | 66ms / 0 | 13.08MB |
| 静态 rich Markdown | 50k / 1 | 118.3 / 118.3ms | 122.7 / 122.7ms | 122ms / 1 | 19.87MB |
| 脱敏真实累计 trace | 174 / 128 | 0.5 / 0.6ms | 1.0 / 1.3ms | 0 / 0 | 6.62MB |
| 持续未闭合 code fence | 20k / 128 | 3.9 / 5.1ms | 7.0 / 8.2ms | 0 / 0 | 26.99MB |
| 多个闭合 rich block | 20k / 128 | 33.6 / 43.6ms | 39.0 / 49.8ms | 0 / 0 | 65.87MB |

真实 trace 期间的 controlled-input commit p95/max 为 `0.3/0.7ms`，Event Timing p95 为
`24ms`。50k 静态冷渲染的约 123ms 是已记录的极长 final 边界，不是典型流式门；因此没有用
batching 增加 terminal flush、恢复和替换复杂度。

## 视觉证据与 golden

在线参考环境为 Windows Chrome `151.0.7922.138`、100% zoom、浅色、DPR 1；桌面参考
viewport 为 `2560 × 1249`，移动补测为 `390 × 844`。在线页面只用于点时测量，不进入 CI，
不保存 URL、Cookie、登录态或真实对话截图。

2026-08-16 使用用户已打开、AI 回复相同的 iChat 与 ChatGPT 页签做了第二轮逐段测量：

- 桌面两边正文根节点均为 `768px`；排除公式、Mermaid、Chart、Reasoning 后，前 111 个子元素
  的相对 `y`/高度最大差为 `0.334px`，后续已进入 viewport 的 section 差为 `0px`；
- 390px 两边正文均位于 `x = 16px`、宽约 `342.667px`；非排除 section 的相对位置与高度差
  为 `0–0.334px`；
- 390px 首个宽表格两边均为 outer `x = 0 / width = 390px`、table
  `x = 16 / width ≈ 440.198px`、`scrollWidth = 472px`；长 plain code viewport 两边均约
  `297.333px`，且只由自己的 scroller 承担横向溢出；
- Python 工具栏两边均为 actions `123.333 × 36px`、copy `36 × 36px`、run
  `77.333 × 36px`；HTML 两边均为 toggle `74 × 36px`、actions `112 × 36px`；
- HTML preview 的桌面外壳两边均为 `768 × 480.583px`，iframe 相对外壳均为
  `x/y = 1.333/49.333px`、`765.333 × 429.917px`；390px 外壳均为
  `342.667 × 241.333px`，preview/iframe 分别为 `341.333 × 192px` 和 `340 × 190.667px`；
- code、copy、play、HTML、fullscreen、external-link glyph 直接核对当前 ChatGPT sprite path；
  header、按钮、表格 cell 和 token palette 均用 computed style 交叉确认；
- Python、JavaScript、TypeScript、JSON、Bash、SQL、YAML、HTML、CSS 与 diff/plain 的参考
  token run 和颜色逐项核对一致。

本地真实浏览器验收覆盖：

- final、streaming、share 相同 Markdown 的语义签名、宽度与 computed style；
- failed/cancelled/recovered partial；
- ThinkingBlock 折叠/展开；
- code/table hover、focus-visible、成功/失败复制、Python 工具栏、HTML code/preview 切换、
  sandbox 属性、fullscreen control 和独立横向滚动；
- desktop `1440 × 900` 与 mobile `390 × 844` 页面 overflow。

用户于 2026-08-15 批准以下 Windows Chromium 全页 golden：

| Baseline | 文件 | 大小 |
|---|---|---:|
| Desktop | `assistant-rendering-golden-desktop-chrome-win32.png` | 496,046 bytes |
| Mobile | `assistant-rendering-golden-mobile-chrome-win32.png` | 450,082 bytes |

文件位于
`frontend/tests/visual/assistant-rendering.visual.ts-snapshots/`。截图不使用宽泛 mask；写入前会
等待复制反馈计时器复位、清除 hover/focus 并回到顶部。Windows 以外平台继续运行同一语义、
交互和几何断言，但不声称不同字体栅格逐像素一致。性能压力页是数值门禁，不进入 golden。

## 范围边界与剩余差异

1. ChatGPT 点时参考的页面 canvas 为 `rgb(252, 252, 252)`；iChat 既有 host canvas 为
   `#fbfbfa`。助手 surface 本身保持透明，正文几何、排版与 rich surface 已对齐。用户批准
   保留应用级 canvas 差异，不为本 feature 改全局页面品牌背景。
2. Python 的“运行”control 已完成视觉与几何复刻，但 iChat 没有 ChatGPT 的远端代码执行沙箱，
   因此该按钮明确禁用，不声称具备执行能力。
3. HTML code/preview/fullscreen 的布局和静态渲染已复刻；iChat 使用空权限本地 iframe，禁止脚本
   和同源能力，ChatGPT 使用其独立 web sandbox。两者的安全执行能力不是本轮视觉 1:1 范围。
4. 参考覆盖的语言已使用 Lezer/轻量词法器逐 token 对齐；其他 Prism fallback 语言若不在固定
   对话样本中，仍只承诺可读、可复制，不声称未测 grammar 的 token role 完全一致。
5. 数学公式、Mermaid、Chart 与 Reasoning 按本轮用户指定不计入 1:1 正文排版差值；KaTeX 与
   ThinkingBlock 仍保留既有回归测试，没有在本轮修改。

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

最终结果：完整 Vitest `73 files / 625 tests`；Playwright desktop visual、mobile visual 和
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
