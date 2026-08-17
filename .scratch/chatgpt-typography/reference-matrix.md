# ChatGPT 文字系统冻结参考矩阵

日期：2026-08-16

本文件是 `.scratch/chatgpt-typography/` 在 tickets 01–06 内的点时事实源。后续 ChatGPT
线上变化不会自动改变这里的目标；如需更新，必须重新采样、记录差异并形成新的产品决定。

## 采样边界

### ChatGPT 实页

| 项目 | 冻结值 |
| --- | --- |
| 页面 | `https://chatgpt.com/c/6a7f53e1-8600-83ee-a156-e586010d3795`（用户已登录的脱敏 renderer 压力样本）与 `https://chatgpt.com/` 空白会话 |
| 采样时间 | 2026-08-16 19:13–19:18（Asia/Shanghai） |
| 浏览器 | Google Chrome `151.0.7922.138`，macOS |
| 会话状态 | 浅色主题、普通会话、富 Markdown 回复、思考展开/折叠、模式菜单、个人资料菜单、设置 Dialog、空白会话禁用状态 |
| 视口 | 富回复与菜单/Dialog：`1470 × 741` CSS px；首次连接页为 `2560 × 1294`，只用于确认 100% zoom |
| DPR / zoom | `devicePixelRatio = 2`；`visualViewport.scale = 1` |
| 字体栈 | `-apple-system-body, ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"` |

浏览器控制对用户已有 ChatGPT 标签页的临时 `1280 × 800` viewport override 没有得到相同的
CSS viewport，因此不伪造该值；上表记录最终实际 computed context。固定桌面/移动 viewport 由
本地 Playwright 承担。富 Markdown 的 Windows Chromium 复核和精确间距继续以
`frontend/tests/visual/assistant-rendering-reference.md` 为补充事实源；两次样本的字号、行高、
字重、颜色和换行规则一致。

### 当前 iChat 与自动化环境

| 项目 | 冻结值 |
| --- | --- |
| iChat 页面 | `http://localhost:5173/c/4cd9b17b-ccea-49c6-b11b-bfb85d39ed00` |
| iChat 采样上下文 | Chrome `151.0.7922.138`，`1280 × 800` CSS px，DPR 1，zoom 100%，浅色 |
| Playwright desktop | `1440 × 900`，DPR 1，浅色，reduced motion |
| Playwright mobile | `390 × 844`，DPR 1，浅色，reduced motion |
| 本地入口 | `frontend/tests/visual/typography-system.html`、`assistant-rendering.html`、`sidebar-scroll.html` |
| 产物边界 | 测量 JSON 和诊断截图只写入 gitignored 的 `frontend/output/playwright/results/`，不进入生产路由或构建入口 |

## 颜色与交互状态

| 语义 | 精确值 | 采样表面与使用规则 |
| --- | --- | --- |
| primary | `#0d0d0d` / `rgb(13, 13, 13)` | 普通 UI、菜单主标签、助手正文、标题、展开思考、表格 |
| secondary interactive | `#5d5d5d` / `rgb(93, 93, 93)` | 回复动作 glyph、空白会话不可用的“工作”分段项；不替代正文 primary |
| tertiary / placeholder | `#8f8f8f` / `rgb(143, 143, 143)` | Sidebar 分组标题、Meta、Composer placeholder、思考折叠标签、Composer 当前“高”值、菜单次级值 |
| disabled text token | `#b4b4b4` / `rgb(180, 180, 180)` | 保留 2026-08-16 初次同环境采样的通用禁用文字值；当前空白页未暴露另一项稳定纯文字样本，不把 icon opacity 当作此 token |
| user message | `#0c274a` / `rgb(12, 39, 74)` | 用户消息只读态和编辑态 |
| selected | 文本保持其 primary/tertiary 角色 | 选中主要由背景、check 或 `aria-selected` 表达；文字不另造选中色 |
| disabled segmented option | `#5d5d5d` | ChatGPT 空白页 disabled “工作”项的实测特例；14/20、500 |
| disabled submit glyph | `rgb(244, 244, 244)` + `opacity: 0.35` | ChatGPT 空白页发送 glyph 的实测特例；属于图标/表面组合，不作为 iChat 文字 token |
| error | iChat `#a6402b` | ChatGPT 当前会话没有稳定可复现的纯文字 error 表面；按 PRD 保留 iChat error tone，排印映射到 `uiText` 或 `metaText`，并保留 `role="alert"`/图标/文案 |
| warning | iChat `#805b12` | 同上，保留 warning tone 与非颜色语义 |
| success | iChat `#39734a` | 同上，保留 success tone 与非颜色语义 |

Hover、focus、selected、loading、disabled 和 error 不改变角色字号或行高。hover/focus 的背景、
focus ring、图标和动效不属于本计划；文字只在 primary、secondary、tertiary、disabled 或现有
状态 tone 之间切换。

## 语义角色矩阵

除 `brandWordmark`、`codeText`、`inlineCode` 和数学内容外，字体均使用上面的 ChatGPT UI 栈；
letter-spacing 均为 `normal`，除非表中另有说明。

| iChat 角色 | ChatGPT 对应表面 | 字号 / 行高 | 字重 | 颜色 | 换行、截断与理由 |
| --- | --- | ---: | ---: | --- | --- |
| `uiText` | Sidebar 会话行、资料库、个人资料菜单项、设置行 | `14 / 20px` | 400 | primary；次级值可 tertiary | 单行导航 `nowrap + ellipsis`；普通可换行 UI 为 `white-space: normal` |
| `uiLabel` | Sidebar“已置顶”、设置字段强调 | `14 / 20px` | 500 | primary 或 tertiary，按层级 | Sidebar 分组为 `nowrap + ellipsis`；字段标签正常换行。实测分组标题是 tertiary，而非旧 PRD 的固定 primary |
| `metaText` | “ChatGPT 也可能会犯错”、Pro 计划、设置说明 | `12 / 16px` | 400 | tertiary | 普通说明 `normal`；短标签 `nowrap`；说明可使用 `text-wrap: balance` |
| `surfaceTitle` | 设置 Dialog 当前 section 标题“常规” | `18 / 28px` | 400 | primary | `text-wrap: balance`；这是 iChat 页面/Dialog 标题无更直接一一对应表面时的最近实测角色 |
| `controlText` | 菜单项、设置 select/button、普通按钮标签 | `14 / 20px` | 400 | primary 或 tertiary | 单行 control `nowrap + ellipsis`；强调提交动作允许 500，不允许缩小字号 |
| `formLabel` | 设置字段“外观”“强调色” | `14 / 20px` | 400 | primary | 正常换行；需要强调时使用 `uiLabel` 的 500 |
| `formValue` | 设置值“系统”“默认” | `14 / 20px` | 400 | primary | ChatGPT 内层 value 的局部 line box 可为 14px，但 iChat 控件根统一保持 20px 可读行盒 |
| `formHelp` | 设置“更强智能”说明 | `12 / 16px` | 400 | tertiary | 正常换行或 balance；长文本不得裁切 |
| `composerText` | Composer contenteditable 与 fallback textarea | `16 / 26px` | 400 | primary | `white-space: break-spaces`、`overflow-wrap: break-word`、`word-break: normal` |
| `composerPlaceholder` | Composer `p[data-placeholder]::after` | `16 / 26px` | 400 | tertiary | `nowrap`；`text-overflow: ellipsis` |
| `composerMode` | Composer 当前“高”触发器 | `16 / 26px` | 400 | tertiary | 正常单行；完整模型/模式名保留在菜单和 accessible name。该颜色由本次复采从旧 PRD primary 更正 |
| `composerMenuItem` | 模式菜单“模型”“推理强度” | `14 / 20px` | 400 | 主标签 primary、值 tertiary | label/value 均 `nowrap + ellipsis` |
| `userMessageText` | ChatGPT 用户气泡 | `16 / 24px` | 400 | user message | `white-space: pre-wrap`、`overflow-wrap: anywhere`、`word-break: normal` |
| `assistantText` | 助手 Markdown paragraph | `16 / 26px` | 400 | primary | `white-space: normal`、`text-wrap: wrap`、`overflow-wrap: break-word`、`word-break: normal` |
| `reasoningCollapsed` | “思考了 18s”折叠按钮 | `16 / 24px` | 400 | tertiary | 正常换行；streaming 不改变字号 |
| `reasoningText` | 展开思考 paragraph | `16 / 24px` | 400 | primary | `normal + wrap + break-word` |
| `markdownH1` | 富回复 H1 | `24 / 32px` | 600 | primary | `normal + wrap + break-word` |
| `markdownH2` | 富回复 H2 | `20 / 28px` | 600 | primary | 同上 |
| `markdownH3` | 富回复 H3 | `18 / 28px` | 600 | primary | 同上 |
| `markdownH4` | 富回复 H4 | `16 / 24px` | 600 | primary | 同上 |
| `markdownH5` | 富回复 H5 | `16 / 26px` | 600 | primary | 同上 |
| `markdownH6` | 富回复 H6 | `16 / 26px` | 400 | primary | 同上 |
| `markdownList` | 富回复 UL/OL item | `16 / 26px` | 400 | primary | 与正文相同；marker 单独 700，不缩正文 |
| `markdownQuote` | 富回复 blockquote paragraph | `16 / 24px` | 400 | primary | `overflow-wrap: break-word` |
| `tableText` | table `td` | `14 / 24px` | 400 | primary | `normal + wrap + break-word`；表格外层独立横向滚动 |
| `tableHead` | table `th` | `14 / 16px` | 600 | primary | `normal + wrap + break-word` |
| `inlineCode` | paragraph inline code | `14 / 26px` | 500 | 当前 code foreground | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`；正常换行、break-word |
| `codeToolbar` | code header “Python”“运行” | `14 / 20px` | 500 | primary | UI 字体；`white-space: pre` |
| `codeText` | CodeMirror/code block | `14 / 20px` | 400 | 当前 syntax foreground | 同一 mono 栈；`white-space: pre`、`text-wrap: nowrap`、`overflow-wrap: normal`，仅源码 viewport 横向滚动 |
| `attachmentTitle` | 最近的 ChatGPT 普通 UI/文件卡标题层级 | `14 / 20px` | 500 | primary | 单行 `nowrap + ellipsis`；当前会话没有稳定附件卡，采用同密度菜单/字段强调角色并记录理由 |
| `attachmentMeta` | 最近的 ChatGPT Meta/帮助层级 | `12 / 16px` | 400 | tertiary 或现有状态 tone | 正常换行；文件名不缩小解决溢出 |
| `sourceTitle` | 最近的 ChatGPT 普通 UI 标题层级 | `14 / 20px` | 500 | primary | 最多两行或产品既有 clamp；不使用半像素字号 |
| `sourceMeta` | 最近的 ChatGPT Meta 层级 | `12 / 16px` | 400 | tertiary | 正常换行；来源 URL/域名允许 ellipsis |
| `semanticStatus` | ChatGPT 普通 UI/Meta 密度 + iChat tone | 主状态 `14 / 20px`；紧凑说明 `12 / 16px` | 400 | neutral/error/warning/success tone | 必须同时保留图标、role 或明确文案；Toast、InlineStatus、上传/解析状态均按重要性二选一，不另造字号 |

### 富 Markdown 节奏

标题与正文的 margin、列表 padding、代码/表格几何不是新的 JSX 角色，继续由
`.assistant-markdown` 窄作用域消费。完整冻结值见
`frontend/tests/visual/assistant-rendering-reference.md`；本次复采确认正文、H1–H6、列表、引用、
表格、inline code、代码块和 code toolbar 与该文件一致。

## 表面映射

| iChat 表面 | 目标角色 |
| --- | --- |
| Sidebar 会话行、新建对话、普通菜单项 | `uiText` / `controlText` |
| Sidebar 分组、选中字段、重要短标签 | `uiLabel`，颜色按层级选择 primary/tertiary |
| UserMenu、Dropdown、BottomSheet | `uiText`；说明/账号计划 `metaText` |
| ConfirmDialog、ModalDialog、ShareDialog | `surfaceTitle` + `uiText` + `controlText`；说明较弱时 `metaText` |
| AccountCard、MySharesCard、AvatarCropper | `surfaceTitle` + `formLabel` + `formValue` + `formHelp` |
| AuthScreen 与认证生命周期页 | 品牌节点走品牌冻结表；其余标题/表单/帮助分别走 `surfaceTitle`、`form*`、`controlText` |
| Toast、VerifyEmailBanner、InlineStatus | `semanticStatus`；保留现有 tone 与非颜色信息 |
| SharePage | 品牌节点冻结；正文复用 `assistantText`/Markdown 角色；页头与状态走 UI/Meta 角色 |
| AttachmentCard、MessageAttachments、SourcesPanel | `attachment*` / `source*` / `semanticStatus` |

## 品牌字标冻结基线

品牌字体 CSS 栈保持：`"Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans CN", sans-serif`。
品牌不迁移到 ChatGPT UI 栈。唯一现有上下文例外是 `.sidebar-desktop .wordmark`：它当前继承
Sidebar 的系统字体栈，必须作为已有视觉事实保留，不能在 ticket 02 中被“修正”为 Inter。

| 变体 | family | size / line-height | weight | spacing | transform | color | 边界/可见性 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Wordmark 默认/Verify/Reset/Confirm/Share desktop | 品牌栈 | `18 / 28.8px` | 600 | `-0.45px` | `matrix(1.04, 0, 0, 0.9, 0, 0)` | 当前 `#1a1a19` | macOS Playwright：`43.810 × 25.917px`；相同环境下所有 18px 变体必须一致 |
| Sidebar desktop expanded | ChatGPT UI 栈（现有 scoped 例外） | `18 / 24px` | 600 | `-0.27px` | 同上 | `#0d0d0d` | iChat Chrome：`44.744 × 21.600px`（`x=18, y=17.2`）；Playwright `44.753 × 21.600px` |
| Sidebar desktop collapsed rail | 无可见 Wordmark | — | — | — | — | — | 260px panel 中的 18px Wordmark 留在 DOM 但随 panel `opacity: 0`；52px rail 只显示图标 |
| Sidebar mobile drawer / Share mobile | 品牌栈 | `20 / 32px` | 600 | `-0.50px` | 同上 | 当前 `#1a1a19` | macOS Playwright：`47.970 × 28.800px`；两个 20px 变体必须一致 |
| AuthScreen 独立标题 | 品牌栈 | `22 / 35.2px` | 600 | `-0.44px` | `none` | 当前 `#1a1a19` | macOS Playwright：`51.031 × 35.188px`；独立于 `Wordmark.tsx` |

这里纠正了旧 PRD 对 Sidebar 的描述：当前 desktop expanded 是 18px，collapsed rail 没有可见
字标；20px 对应 mobile drawer。后续 tickets 必须以本表和 fixture 为准。

## 当前已对齐区域基线

### 助手 Markdown

- iChat Chrome `1280 × 800`：正文根/首段均为 `768px` 宽、`16 / 26px`、400、`#0d0d0d`；
  UI 栈、`normal + wrap + break-word` 与 ChatGPT 一致。
- 详细节点与 Windows/mobile screenshot golden 由 `assistant-rendering.visual.ts` 继续保护。

### Desktop Sidebar

- aside：`260 × 800px`，UI 栈、`16 / 24px` 根行盒、primary `#0d0d0d`。
- 分组“聊天”：`14 / 20px`、500、tertiary `#8f8f8f`、nowrap。
- 会话行：`14 / 20px`、400、primary、`nowrap + ellipsis`。
- 实际组件的 computed JSON 由 `sidebar-scroll.visual.ts` 写入测试产物；新 fixture 同时提供独立
  文字基线卡，防止 fixture 布局变化掩盖生产 Sidebar 回归。

## 响应式与长文本规则

- 同一角色在 desktop/mobile 保持相同字号、行高和字重；移动触摸目标通过 padding/min-size
  保证，不放大文字。
- 320、375、390/414、768、1280px 和 200% zoom 的最终验收由 ticket 06 执行。
- 用户消息使用 `pre-wrap + anywhere`；助手正文使用 `normal + break-word`；代码使用独立横向
  scroller；表格只在自身 viewport 横向滚动；单行导航、模型值和文件名使用 ellipsis。
- 长 URL、连续英文、中文、数字、标点和 emoji 已进入 `typography-system.html`，任何页面级
  水平 overflow 都是失败。
