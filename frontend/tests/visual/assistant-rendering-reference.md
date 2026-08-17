# 助手回复渲染参考记录

日期：2026-08-15

复核日期：2026-08-16

本记录来自用户已登录 Chrome 中指定的 ChatGPT 示例对话。在线页面仅用于本次点时测量；自动测试不访问 ChatGPT，也不保存会话 URL、Cookie、登录态或真实对话截图。

## 固定环境

| 项目 | 记录值 |
| --- | --- |
| Chrome | `151.0.7922.138`（Windows） |
| 页面缩放 | 100%；`visualViewport.scale = 1` |
| 主题 | 浅色；computed `color-scheme: light` |
| 桌面参考 viewport | `2560 × 1249` |
| 移动参考 viewport | `390 × 844` |
| device scale factor | 两次固定 viewport 测量均约为 `1` |
| computed 字体栈 | `-apple-system-body, ui-sans-serif, -apple-system, system-ui, Segoe UI, Helvetica, Apple Color Emoji, Arial, sans-serif, Segoe UI Emoji, Segoe UI Symbol` |
| Windows 主 UI 字体 | `system-ui` 落到 Segoe UI；中文 glyph 仍可能逐字回退，当前浏览器控制接口不能可靠给出每个 glyph 的最终字体，因此不把中文 fallback 写死为 baseline |

所有尺寸均为 CSS px。Windows 默认窗口原本处于 150% 显示缩放；测量时通过浏览器 viewport override 固定为 `deviceScaleFactor ≈ 1`，避免把系统显示缩放混入参考。

## 桌面 computed style

助手 Markdown 根节点宽 `768px`，字体 `16px / 26px`、字重 400、正文色 `rgb(13, 13, 13)`，背景为透明，`overflow-wrap: break-word`。页面背景为 `rgb(252, 252, 252)`。

| Surface | 字号 / 行高 | 字重 | 关键几何与样式 |
| --- | --- | --- | --- |
| H1 | `24 / 32` | 600 | 下边距 8 |
| H2 | `20 / 28` | 600 | 上边距 16、下边距 4 |
| H3 | `18 / 28` | 600 | 上边距 16、下边距 4 |
| H4 | `16 / 24` | 600 | 上边距 16 |
| H5 | `16 / 26` | 600 | 无额外上下边距 |
| H6 | `16 / 26` | 400 | 无额外上下边距 |
| Paragraph | `16 / 26` | 400 | 普通段落上下 16；首段或紧随标题/rich surface 时上 0/8、下 4 |
| Inline code | `14 / 26` | 500 | 背景 `rgb(236, 236, 236)`；圆角 4；padding `2.4px 4.8px`；无可见边框 |
| Blockquote | `16 / 24` | 400 | padding `8px 0 8px 24px`；4px、15% 黑色、2px 圆角竖线 |
| UL / OL | `16 / 26` | 400 | 左 padding 26；item 无额外垂直 margin；marker 700 |
| Task checkbox | — | — | `16 × 16px`；unchecked 1px `#9b9b9b` 边框；checked 使用蓝色填充和固定 check path |
| Link | `16 / 26` | 400 | 正文色、1px dotted underline；外链追加 `12 × 12px` glyph |
| HR | — | — | 768px 宽；约 0.667px 高；上下 margin 28 |

代码块样本的外壳宽 `768px`、圆角 24、背景 `rgb(243, 243, 243)`，外边框约
`0.667px solid rgba(0, 0, 0, 0.05)`。有语言代码的 header 高 `48px`，左侧为 16px
code glyph 与 `14px / 20px`、500 的语言名，右侧 copy control 为 `36 × 36px`。无语言和
plain/text fence 不显示 header。代码内容为 `14px / 20px`，桌面 padding
`0 16px 12px 20px`，`white-space: pre`；内容 viewport 持有 `overflow-x: auto`，水平 scrollbar
约 `15.667px`。示例块总高会随内容变化，不作为长期固定值。

Python header 的 actions 为 `123.333 × 36px`：copy `36 × 36px`，间隔 2px，再加 8px
run 左间距和 `77.333 × 36px` 的“运行”按钮。HTML header 使用专属 16px glyph，右侧
code/preview toggle 为 `74 × 36px`、完整 actions 为 `112 × 36px`。preview header 背景改为
`rgb(252, 252, 252)`；`16:9` preview 在 768px 外壳内为 `766.667 × 431.25px`，内部 iframe
为 `765.333 × 429.917px`。Piko 的 iframe 使用空权限 `sandbox`；此处记录的是静态 preview
布局，不把 ChatGPT 的远端执行 sandbox 当作正文排版要求。

表格为 `14px`，使用透明背景、0 圆角、`border-collapse: separate` 和 0 `border-spacing`，没有
可见外壳边框。header 为 600 / 16px line-height、bottom 对齐、padding `8px 24px 8px 0`；
cell 为 400 / 24px line-height、baseline 对齐、padding `10px 24px 10px 0`；非首列左 padding
为 8px，最后一个 header 右 padding 为 40px，最后一行 bottom padding 为 24px。桌面 cell
宽度约束为 `128–192px`。外层 viewport 扩展到整个 thread 可用宽度并持有
`overflow-x: auto`；内部 table 从 768px 正文列的左边界开始。复制按钮为 `28 × 28px`、20px
filled copy glyph、圆角 4 的覆盖按钮，只在 table hover/focus-within 时出现，并随 table wrapper
横向滚动。普通外链为 `target="_new"`、`rel="noopener"`。

## 390px 移动 computed style

该视口为真实补测，不从桌面值推断：

- 页面 `clientWidth = scrollWidth = 390px`，没有页面级水平溢出。
- 助手正文列位于 `x = 16px`，宽约 `342.667px`。
- 正文仍为 `16px / 26px`；H1–H6 与桌面字号、行高、字重一致。
- 行内代码仍为 `14px / 26px`、圆角 4、padding `2.4px 4.8px`。
- blockquote 宽约 `342.667px`，仍使用 `8px 0 8px 24px`。
- 有语言代码的 surface 宽约 `342.667px`，header 内宽约 `341.333px`、高 `48px`，copy control
  `36 × 36px`；代码 padding 改为 `0 12px 12px 16px`。
- Python actions 在移动端仍为 `123.333 × 36px`；HTML toggle/actions 仍为 `74/112 × 36px`。
  HTML preview 外壳为 `342.667 × 241.333px`，preview/iframe 分别为
  `341.333 × 192px` 与 `340 × 190.667px`。
- 长 plain code 的 surface 宽约 `342.667px`，无 header，内部水平 viewport 宽约
  `297.333px`；Piko 与 ChatGPT 的源码起点均为 `x ≈ 32.667px`。
- 首个宽表格的 outer 两边均为 `x = 0 / width = 390px`，table 均为
  `x = 16 / width ≈ 440.198px`，outer `scrollWidth = 472px`；三列表格 table 宽 `358px`，
  不产生水平 overflow。
- 移动表格 cell 宽度约束为 `106.667–160px`；复制按钮的 hover/focus 隐藏规则和随内容滚动
  行为已在真实页签与本地 Playwright 中共同验证。

## 2026-08-16 双页签差值

用户 Chrome 中 Piko 与 ChatGPT 使用相同 AI 回复，且两边都固定为相同 viewport 后：

- desktop 正文根节点均为 768px；排除 math、Mermaid、Chart、Reasoning 后，前 111 个对应节点
  的相对 y/height 最大差 `0.334px`，后续已实际进入 viewport 的 section 差为 `0px`；
- 390px 正文根节点均为 `x = 16px / width ≈ 342.667px`；非排除 section 的相对 y/height
  差为 `0–0.334px`；
- code、copy、play、HTML、fullscreen、external-link glyph 的 SVG path 与当前 ChatGPT
  sprite 对应 symbol 完全相同；
- Python 与 HTML 工具栏在桌面/移动端的 width、height、relative x/y 均相同；HTML preview
  的外壳、header、16:9 容器和 iframe 尺寸均相同；
- Python、JavaScript、TypeScript、JSON、Bash、SQL、YAML、HTML、CSS 与 diff/plain 的
  token run 和 palette 已逐项相同。Piko 对这些语言使用按需 Lezer parser 或轻量词法分类；
  其他 Prism fallback 语言不写入未测的 1:1 结论。

## 本地 harness

- 入口：`tests/visual/assistant-rendering.html`
- Playwright：`playwright.config.ts`
- 场景：完整正文、14 组未闭合流式 prefix、final/streaming/share 生产入口、失败/取消/刷新恢复 partial、Clipboard promise 成功/失败、Python 工具栏、HTML code/preview/sandbox/fullscreen、代码/表格滚动与 focus-visible、ThinkingBlock 折叠/展开。
- 自动 viewport：`1440 × 900` 与 `390 × 844`，浅色、reduced motion、`deviceScaleFactor = 1`。
- 诊断产物：`output/playwright/results/`（已 gitignore）。
- 已批准 Windows Chromium golden：
  `assistant-rendering.visual.ts-snapshots/assistant-rendering-golden-desktop-chrome-win32.png`
  与 `assistant-rendering-golden-mobile-chrome-win32.png`。截图前会等待复制反馈复位、清除
  hover/focus 并回到页面顶部；性能压力页不进入 golden。

运行：

```bash
pnpm run test:visual
```

fixture 使用脱敏静态内容，不依赖认证、API 或生产路由；默认 `vite build` 仍只以根 `index.html` 为正式应用入口。
