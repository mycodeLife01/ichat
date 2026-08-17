# ChatGPT 文字系统 ticket 06 最终交接

- 日期：2026-08-16
- 分支：`fix/sidebar-scrollbar`
- 范围：`.scratch/chatgpt-typography/` tickets 01–06 最终验收与收口
- 状态：全部完成；没有后续 frontier

## 最终结论

ChatGPT-aligned 文字系统已按 2026-08-16 冻结 reference matrix 完成 tickets 01–06。除 iChat
品牌、助手代码与数学内容的明确字体例外外，所有用户可见文字都使用 ChatGPT UI 栈和语义角色；
根基线为 16px / 24px。助手 Markdown、桌面 Sidebar 和全部品牌字标保护区无未经批准的变化。

Ticket 06 没有修改生产组件、文案、API、状态机、业务行为或视觉样式。验收没有发现需要消费者级
修复的真实回归；本票只扩展现有 `frontend/tests/visual/typography-system.*` 证据、更新前端架构规则、
完成 ticket/PRD 状态与最终交接。

## Tickets 01–06 汇总

| Ticket | 最终状态 | 交付结果 |
| --- | --- | --- |
| 01 | completed | 冻结 ChatGPT 点时 reference matrix、所有 Wordmark/Auth 品牌基线，以及助手/Sidebar/长文本 visual fixture。 |
| 02 | completed | 建立 `--font-ui`、文字尺度/字重/颜色 token 和 `classes.ts` 共享语义角色；已对齐区域无视觉变化地消费 token。 |
| 03 | completed | 迁移 Composer、用户/助手消息相邻表面、Thinking、引用/来源、附件与 Run/tool 状态；六档宽度自然回流通过。 |
| 04 | completed | 迁移 Sidebar、菜单/BottomSheet、Dialog、账户/分享/认证和 Toast/状态表面；焦点与业务守卫保持。 |
| 05 | completed | 把 `html/body` 切到 UI / 16 / 24，清除遗留任意字号、任意 leading、组件字体和 rem 漂移；保护全部前序几何。 |
| 06 | completed | 对 reference matrix 全角色、视口、200% zoom、对比度、状态非颜色通道、品牌、golden 和机械审计完成最终验收并写入维护规则。 |

`.scratch/chatgpt-typography/PRD.md` 现为 `completed`，Ticket Index 的 01–06 全部为
`completed`，frontier 明确为无；不要为本系列创建下一任务。

## Ticket 06 浏览器证据

`typography-system.visual.ts` 现在显式列出 reference matrix 的 34 个角色，并逐一断言真实生产
渲染节点的 font family、size、line-height、weight、letter-spacing、color 及对应换行/截断规则。
覆盖范围包括：

- `uiText`、`uiLabel`、`metaText`、`surfaceTitle`、`controlText` 与全部 `form*`；
- `composer*`、`userMessageText`、`assistantText`、`reasoning*`；
- Markdown H1–H6、段落、列表、引用、链接、inline code、code toolbar/source、表头与表格正文；
- attachment/source/status 角色，生产 Composer、Message、ThinkingBlock、Citation、SourcesPanel、
  AttachmentCard、StreamingMessage；
- Sidebar、UserMenu、Popover、BottomSheet、Dialog、账户/分享/裁剪/认证生命周期/公开分享页；
- Wordmark 18px/20px、Sidebar desktop/mobile、Share desktop/mobile、Verify/Reset/Confirm 与
  AuthScreen 22px 独立标题；
- 中文、英文、数字、标点、emoji、连续长单词、长 URL 和混排。

浏览器为 Playwright Chromium、DPR 1、浅色、reduced motion。desktop 项目逐档执行：

- 320×844
- 375×844
- 390×844
- 414×844
- 768×900
- 1280×800

mobile 项目继续固定 390×844。每档产生 `chat-core-*`、`secondary-navigation-*`、
`secondary-states-*` 截图；desktop/mobile 还产生完整 `typography-system.png`。所有页面级
`scrollWidth` 均未超过 `clientWidth`，菜单、BottomSheet、来源面板、Citation、长状态与附件没有
裁切、遮挡或异常换行。截图只保存在 gitignored 的 `frontend/output/playwright/results/`。

现有 `assistant-rendering.visual.ts` desktop/mobile approved golden 在无
`--update-snapshots` 参数下通过；没有产生 snapshot diff。Wordmark/Auth 的 family、size、
line-height、weight、letter-spacing、transform、color、opacity 与 bounding box 继续逐项通过，
macOS 下同时验证冻结的精确边界。

## 200% zoom 与可访问性

200% 验收使用真实 Chromium device-metrics override：物理画布 1280×800、CSS viewport
640×400、`scale=2`，截图 PNG 仍为 1280×800。证据文件为：

- `typography-zoom-200-auth.png`
- `typography-zoom-200-states.png`

实测结果：

- 注册表单所有可见 button/input/link 都可逐一滚入 640×400 CSS viewport，水平和垂直边界可达；
- 键盘 Tab 可聚焦用户名字段，focus-visible outline 为 2px；
- 空表单提交后字段错误继续可见，`aria-describedby="auth-username-error"` 仍与错误节点关联；
- error/warning/success 与长帮助文字自然增高，只产生允许的垂直滚动，没有页面级横向滚动；
- 代表性 primary 对实际祖先背景的 WCAG 对比度全部 >= 4.5:1，最低样本是用户消息
  `#0c274a` / `#f4f3f0` 的 13.47:1；
- InlineStatus error 使用 `role="alert"`，warning/success 使用 `role="status"`；三者与 warning
  Toast 都有 tone 对应图标和明确文案，上传失败还保留显式“上传失败”文字，因此状态不依赖颜色。

## 机械审计与允许例外

对 `frontend/src` 的最终 `rg` 审计：

- arbitrary pixel text：0
- arbitrary leading：0
- 10.5/11.5/12.5/13.5px 功能字号：0
- 响应式 arbitrary type：0
- 组件级 `font-sans`：0
- 组件级 `fontFamily`：0
- `global.css` 之外的 CSS `font-family`：0

允许例外保持集中且有浏览器契约：

1. `Wordmark.tsx` 的动态 `fontSize` 是唯一 inline font metric；Wordmark 与 AuthScreen 使用
   `--font-sans`，Sidebar desktop Wordmark 保持已有的 UI 栈继承例外。
2. 助手 inline/source code 使用 `--font-code`；code toolbar 保持 UI 栈。
3. KaTeX 后代继续使用第三方 `KaTeX_*` family；`--font-serif` 只保留给明确内容语义，不是 UI
   fallback。
4. `global.css` 的八处 `font-family` 只对应上述品牌、UI 根/Sidebar/Markdown 和代码作用域；
   `.external-link-icon` 的 `line-height: 0` 是非文字 glyph 几何，不是功能文字例外。
5. 唯一显式 rem 命中是 `codeHighlight.test.ts` 中用于高亮输入的 `48rem` CSS 字符串，不进入生产
   样式。

## 架构维护规则

`docs/architecture/frontend.md` 现已记录：

- reference matrix 是点时来源，`global.css` token 与 `classes.ts` 语义角色是运行时事实源；
- 普通 UI、表单、Composer、消息、Markdown、附件/来源/状态应如何选择角色；
- 16/24 根基线、品牌冻结边界、集中字体例外和 Wordmark inline metric 边界；
- 新文字不得新增 arbitrary size/leading、半像素功能字号、组件字体或无参考的响应式字号；
- 长文本按阅读、用户消息、单行省略、代码/表格各自的策略处理，不能靠缩小字号规避；
- 新表面必须复核 4.5:1 primary 对比度、状态非颜色通道、真实浏览器 computed style、200% zoom
  与 assistant golden。

`docs/README.md` 已增加本交接入口；没有新增另一套测试体系或生产路由。

## 最终验证

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
```

仓库根目录执行并通过：

```bash
git diff --check
```

最终结果：

- Vitest：74 files / 634 tests passed；
- Playwright：30 passed / 22 expected skips（52 configured）；
- lint：0 errors；只有既有 `authFields.tsx` Fast Refresh warning；
- typecheck：通过；
- production build：通过；只有既有 large chunk warning；
- assistant desktop/mobile golden：通过，无更新；
- mechanical typography audit 与 `git diff --check`：通过。

## 保护区与未提交 workspace

以下仍是保护区：冻结 reference matrix、16/24 根基线、助手 Markdown golden、768px 内容列、
desktop Sidebar 14/20、所有品牌变体、集中字体例外、六档长文本回流、状态 tone/非颜色语义，以及
tickets 01–05 的 API/Reducer/Run/附件/分享/认证业务边界。后续如需追随 ChatGPT 新版本，必须作为
新的产品决定重新采样，不能静默改动本次冻结目标。

本系列继续直接保留在当前分支与共享 workspace，没有创建 worktree、分支、提交或下一任务。
最终 `git status --short` 为 46 个 modified、11 个 untracked，共 57 个未提交路径；其中包含
reference matrix、tickets 01–06 handover、完整 typography visual fixture，以及 tickets 01–05 的
生产迁移与回归测试。全部改动保持未提交，交由用户统一审阅或提交。
