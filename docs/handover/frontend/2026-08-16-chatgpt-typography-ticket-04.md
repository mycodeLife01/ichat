# ChatGPT 文字系统 ticket 04 交接

- 日期：2026-08-16
- 分支：`fix/sidebar-scrollbar`
- 范围：`.scratch/chatgpt-typography/` 的 ticket 04；下一步只从 ticket 05 进入。

## 当前状态

Ticket 04 已完成，聊天核心以外的次级页面、控件和状态文字已迁移到 ticket 02 建立的语义角色。
Ticket 05 的 03、04 前置现已全部满足，当前 frontier 为 ticket 05；ticket 06 仍受 ticket 05 阻塞。

本次直接在 tickets 01–03 的未提交工作区上继续，没有创建 worktree、分支或提交，也没有实施
ticket 05/06。权威需求和下一票入口位于：

- `.scratch/chatgpt-typography/PRD.md`
- `.scratch/chatgpt-typography/reference-matrix.md`
- `.scratch/chatgpt-typography/issues/05-switch-root-and-remove-legacy-overrides.md`
- `.scratch/chatgpt-typography/issues/06-visual-acceptance-and-documentation.md`

## 本次落地

### 导航、菜单与移动表面

- Sidebar 会话行、新建对话使用 `uiText`，分组标题使用 tertiary `uiLabel`，空列表和加载说明使用
  `metaText`；移除了移动端 15px/13.5px 放大，桌面与移动均保持 14/20 或 12/16。
- UserMenu 的触发器、Popover/BottomSheet 菜单项、姓名、邮箱和计划信息分别消费 `uiText`、
  `uiLabel`、`metaText` 与 `controlText`；桌面 Portal 中的头像首字母也显式使用 UI 字体。
- `neutralMenuItem`、`dangerMenuItem` 和 `mobileActionItem` 共用相同文字角色；移动端仍通过 44px
  最小高度和原 padding 保证触摸面积，没有通过放大字体实现。
- ModalDialog 与 BottomSheet 根表面显式提供 UI 字体和 primary 文字上下文，焦点转移、Escape、Tab trap、
  Portal 与关闭行为未改。

### Dialog、表单、账户与分享

- ConfirmDialog、ShareDialog、AccountCard、MySharesCard、AvatarCropper 的标题、说明、字段、Meta、按钮和
  状态分别映射到 `surfaceTitle`、`form*`、`ui*`、`controlText` 和 `semanticStatus*`。
- 输入控件统一使用 14/20 `formValue`，placeholder 使用 tertiary，disabled 使用 `#b4b4b4`；提交动作
  保留允许的 500 强调，现有 error/warning/success tone 和图标/role 同时保留。
- AuthScreen 仅迁移非品牌表单文字；22px `iChat` 标题 class 完全不变。ResetPasswordPage、
  VerifyEmailPage、ConfirmAccountDeletionPage 统一了标题、帮助、加载状态和控件角色。
- SharePage 的页头、页面标题和错误状态完成迁移；其 `SharedMessageView`、助手 Markdown、SourcesPanel 和
  消息附件继续复用 ticket 03 角色，没有重新调整聊天渲染。
- AppShell 空白会话标题改用 `surfaceTitle`；附件上传、解析、失败和警告继续消费 ticket 03 已落地的
  `attachment*` / `semanticStatus*`，没有修改 AttachmentCard 或聊天附件实现。

### 共享状态与长文本

- `inputControl`、`statusNotice`、`toastSurface` 和菜单原语现在直接组合 ticket 02 角色，不再携带
  12.5px/13px/14px 等局部功能字号。
- InlineStatus 的正文、`formHelp` 和 `surfaceTitle` 允许正常换行与 `break-word`；连续英文、长邮箱和
  中英文混排不会通过缩小字号解决。
- Toast 保持原颜色、边框、圆角、阴影、动画和状态语义，只增加 `100vw - 32px` 最大宽度与可换行正文，
  修复 320–414px 下长连续英文越过视口的问题。
- 仍按矩阵保留有意的单行省略：Sidebar 会话标题、UserMenu 邮箱、账户标识和分享标题。完整信息继续存在
  于 DOM/accessibility tree；没有新增文案或改变动作名称。

## 自然 reflow 与可接受变化

- Sidebar 和 UserMenu 的移动文字回到与桌面相同的 14/20、12/16 后，行盒密度变化，但 44px 触摸目标、
  图标位置和交互范围不变。
- Dialog/页面标题统一为 18/28、400；较长标题会 balance 并按单词边界自然换行，不截断。
- 说明、Meta 和紧凑状态统一为 12/16，长说明会增加容器自然高度；AccountCard 与 MySharesCard 的既有
  内部滚动边界继续承担小视口高度。
- 长 Toast、InlineStatus、邮箱和公开分享标题在窄屏自然回流；输入 placeholder 继续保持单行控件语义，
  由输入框边界自然裁切显示而不造成页面横向滚动。
- 没有通过改小字号、扩大容器、改变触摸目标或改写文案规避溢出。

## 保护区

- `html/body` 继续为 `var(--font-sans)`、15px、1.6（computed 24px）；ticket 05 才允许切换根基线。
- `frontend/src/ui/Wordmark.tsx` 未修改；所有 18px/20px Wordmark、Sidebar desktop scoped 例外和
  AuthScreen 22px 品牌标题继续通过 ticket 01 的字体、字号、行高、字重、字距、transform、颜色与
  bounding-box 断言。
- 助手 Markdown 继续为 16/26，desktop/mobile renderer 与现有截图证据无未经确认的变化。
- Composer、Message、ThinkingBlock、Citation、SourcesPanel、聊天附件及 ticket 03 的六宽度生产夹具
  保持原角色和行为；本票仅在同一个 fixture 中追加次级表面入口与断言。
- 产品文案、表面色、边框、圆角、阴影、图标 glyph/size、动效、触摸目标、焦点管理、API、Reducer、
  handler 和业务流程均未改变。

## 验证

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
```

结果：Vitest 74 files / 634 tests；Playwright 28 passed / 20 expected skips；lint、typecheck 和
production build 通过。Lint 只报告项目既有的 `authFields.tsx` Fast Refresh warning，退出码为 0；
Vite 只有项目既有的大 chunk 提示，退出码为 0。仓库根目录的 `git diff --check` 通过。

`frontend/tests/visual/typography-system.*` 保留 ticket 03 的生产聊天夹具，并新增次级表面 query 入口。
desktop project 逐一设置 320、375、390、414、768、1280px，验证：

- Sidebar 分组/行/新建按钮、UserMenu 与会话菜单在 desktop Popover/mobile BottomSheet 中均为相同角色；
- 36px desktop/44px mobile 目标高度、菜单/Sheet 视口边界和页面无水平 overflow；
- VerifyEmailBanner、输入/placeholder/disabled、InlineStatus 和长 Toast 的 computed font、字号、行高、
  字重、颜色、tone 与自然换行。

desktop/mobile 两个项目还直接渲染 AuthScreen、AccountCard、MySharesCard、ShareDialog、ConfirmDialog、
AvatarCropper、ResetPasswordPage 和 SharePage，验证长中英文、连续英文、品牌边界、表单/状态色及页面边界。
诊断截图确认变化均为上述自然 reflow，没有文字重叠、意外裁切或页面级横向滚动。

## Ticket 05 入口

从 `.scratch/chatgpt-typography/issues/05-switch-root-and-remove-legacy-overrides.md` 开始。Ticket 05 可以切换
`html/body` 到 `--font-ui` 与 PRD 指定根字号，并逐消费者清理仍存在的 10–17px 任意字号/leading；不要用
全局替换或格式化重写掩盖布局漂移。

继续把本票和 tickets 01–03 的 computed-style/screenshot 当作保护基线，尤其是 Wordmark、AuthScreen
品牌标题、助手 Markdown、聊天夹具、Sidebar/UserMenu/BottomSheet、状态色和长文本回流。Ticket 05
完成前不要实施 ticket 06；当前任务到此停止，不实施 ticket 05/06，也不创建下一任务。
