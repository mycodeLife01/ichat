# 助手回复渲染参考记录

日期：2026-08-15

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
| Paragraph | `16 / 26` | 400 | 下边距 4 |
| Inline code | `14 / 26` | 500 | 背景 `rgb(236, 236, 236)`；圆角 4；padding `2.4px 4.8px`；无可见边框 |
| Blockquote | `16 / 24` | 400 | padding `8px 0 8px 24px`；占满 768px 正文列 |
| UL / OL | `16 / 26` | 400 | 左 padding 26 |
| HR | — | — | 768px 宽；约 0.667px 高；上下 margin 28 |

代码块样本的外壳宽 `768px`、圆角 24、背景 `rgb(243, 243, 243)`，外边框约 `0.667px solid rgba(0, 0, 0, 0.05)`。代码内容为 `14px / 20px`，桌面 padding `0 14px 12px`，`white-space: pre`；`.cm-scroller` 持有 `overflow-x: auto`。示例块总高会随内容变化，不作为长期固定值。

表格为 `14px`；header 为 600 / 16px line-height、padding `8px 24px 8px 0`，cell 为 400 / 24px line-height、padding `10px 24px 10px 0`。外层容器持有 `overflow-x: auto`。普通外链当时为 `target="_new"`、`rel="noopener"`。

## 390px 移动 computed style

该视口为真实补测，不从桌面值推断：

- 页面 `clientWidth = scrollWidth = 390px`，没有页面级水平溢出。
- 助手正文列位于 `x = 16px`，宽约 `342.667px`。
- 正文仍为 `16px / 26px`；H1–H6 与桌面字号、行高、字重一致。
- 行内代码仍为 `14px / 26px`、圆角 4、padding `2.4px 4.8px`。
- blockquote 宽约 `342.667px`，仍使用 `8px 0 8px 24px`。
- 代码内容为 `14px / 20px`；水平 scroller 宽约 `341.333px`，移动 padding 改为 `0 10px 12px`。
- 表格样本 intrinsic 宽约 `440.198px`，其独立容器宽 `390px` 且 `overflow-x: auto`；页面本身仍为 390px。

移动端代码块完整 header 的按钮间距、hover 状态，以及表格复制按钮的精确位置没有通过当前只读测量接口稳定提取；本轮只记录可重复的正文、代码内容、表格和 overflow 几何。后续 ticket 06 在 iChat fixture 获批后固化本地 golden，不用桌面值补猜这些缺口。

## 本地 harness

- 入口：`tests/visual/assistant-rendering.html`
- Playwright：`playwright.config.ts`
- 场景：完整正文、六类未闭合流式 prefix、Clipboard promise 成功/失败、ThinkingBlock 折叠/展开。
- 自动 viewport：`1440 × 900` 与 `390 × 844`，浅色、reduced motion、`deviceScaleFactor = 1`。
- 诊断产物：`output/playwright/results/`（已 gitignore）；本 ticket 不提交 golden screenshot。

运行：

```bash
pnpm run test:visual
```

fixture 使用脱敏静态内容，不依赖认证、API 或生产路由；默认 `vite build` 仍只以根 `index.html` 为正式应用入口。
