# ChatGPT 文字系统 ticket 03 交接

- 日期：2026-08-16
- 分支：`fix/sidebar-scrollbar`
- 范围：`.scratch/chatgpt-typography/` 的 ticket 03；下一步只从 ticket 04 进入。

## 当前状态

Ticket 03 已完成，聊天核心生产表面已迁移到 ticket 02 建立的语义文字角色。当前 frontier 只剩
ticket 04；ticket 05 已满足 ticket 03 前置，但仍受 ticket 04 阻塞。

本次直接在 tickets 01–02 的未提交工作区上继续，没有创建 worktree、分支或提交，也没有实施
ticket 04/05。权威需求和下一票入口位于：

- `.scratch/chatgpt-typography/PRD.md`
- `.scratch/chatgpt-typography/reference-matrix.md`
- `.scratch/chatgpt-typography/issues/04-migrate-secondary-surface-typography.md`
- `.scratch/chatgpt-typography/issues/05-switch-root-and-remove-legacy-overrides.md`

## 本次落地

### 聊天语义角色

`frontend/src/ui/classes.ts` 继续消费 ticket 02 已建立的 attachment/source/status 等角色，只补充聊天
领域确实缺失的复用 seam：

- Composer 菜单次级值、消息动作主次标签和 hover hint；
- 不绑定 tone 的聊天 control/status 别名，复用既有 14/20 与 12/16 密度；
- `messageBubble` 直接组合 `userMessageText`，只读态、展开态和编辑态共享 16/24、系统字体、
  `#0c274a` 与 `pre-wrap + anywhere`。

没有重构 ticket 02 token 层，也没有修改尚待 ticket 04 消费的通用菜单、表单或状态原语默认值。

### Composer 与消息

- Composer textarea 和 placeholder 现在为 16/26；移除了移动端 17px 放大。
- 当前模型/思考 trigger 为 16/26 tertiary，菜单为 14/20，长模型名在可见 trigger 中省略；完整
  模型与思考值保留在菜单和 accessible name。320px 下根模式菜单锚定在 Composer 右缘，不再越过
  左侧视口；工具菜单既有动态定位不变。
- 用户消息只读、展开和编辑态统一为 16/24、系统字体和用户消息色；移动 BottomSheet 消息动作改为
  14/20，44px 触摸目标不变。
- ThinkingBlock 折叠标签为 16/24 tertiary，展开正文为 16/24 primary；长工具查询允许自然换行，
  无内容状态仍通过 28px 最小高度保持原触发区。
- 助手 Markdown 的组件、窄作用域 CSS、结构与内容节奏均未在 ticket 03 中修改；仅其相邻动作、
  引用、来源、附件和 Run 状态迁移角色。

### 引用、来源、附件与 Run 状态

- Citation chip、卡片标题/域名/日期/摘要和 SourcesPanel 映射到 `sourceTitle`、`sourceMeta`；Citation
  卡片桌面仍为 320px，320px 视口时缩为 `100vw - 16px` 并保持两侧 8px，避免负 x 坐标。
- 文件名使用 14/20、500 与既有单行省略；附件 Meta/上传失败/警告使用 12/16 和现有 tone。长失败
  状态不缩字，紧凑卡从固定 60px 改为最小 60px，按文本自然增高。
- 流式搜索标签复用 Thinking 16/24 角色并保留既有 shimmer；Run failed 使用 14/20 error status。
  cancelled 继续只保留 partial 正文，不伪造终态提示，Run 生命周期和恢复语义不变。
- 消息动作 hover hint 使用 12/16；发送、停止、IME、编辑并重发、重新生成、引用/来源打开、上传和
  附件读取的 handler、props、API 与状态机均未改变。

## 自然 reflow 与可接受变化

- 用户消息与 Thinking 正文升到冻结尺度后会更早换行，长用户消息可能更早达到既有 320px 折叠阈值；
  折叠/展开逻辑本身未改。
- 长 Thinking/工具标签由单行省略改为正常换行；Chevron 保持可见，触发区按内容增高。
- 长附件失败说明使卡片高于 60px；文件名仍按矩阵单行省略，状态说明正常换行。
- Citation/来源标题和摘要按既有 clamp 或自然换行；窄屏 Citation 宽度调整仅用于保持可达和防裁切。
- Composer trigger 的可见文本可省略，完整值仍由 accessible name 和菜单提供。没有通过缩小字号解决
  任一溢出。

## 保护区

- `html/body` 继续为 `var(--font-sans)`、15px、1.6（computed 24px）；ticket 05 之前不得切换。
- `frontend/src/ui/Wordmark.tsx`、AuthScreen 22px 品牌标题及所有 Wordmark 使用点未修改；ticket 01
  的字体、字距、transform、颜色和 bounding-box 断言继续通过。
- 助手 Markdown 仍为 16/26，其 desktop/mobile renderer、代码、表格和分享入口 visual 全部通过；
  没有更新或产生 golden snapshot diff。
- 圆角、背景、边框、阴影、图标 glyph/size、动效、文案、API、业务流程和 Run 状态机均未改变。
  为保持原 icon computed color，少量图标从继承色改为等价的显式状态色，但视觉值不变。

## 验证

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
```

结果：Vitest 74 files / 634 tests；Playwright 14 passed / 8 expected skips；lint、typecheck 和
production build 通过。Vite 只有项目既有的大 chunk 提示，不影响退出码。仓库根目录的
`git diff --check` 通过。

`frontend/tests/visual/typography-system.*` 现在直接渲染生产 Composer、Message、ThinkingBlock、
Citation、SourcesPanel、AttachmentCard 和 StreamingMessage，并从 desktop project 逐一设置
320、375、390、414、768、1280px 视口。每档都验证：

- textarea/placeholder/trigger/menu、用户消息三态和 Thinking 两态的 computed font、字号、行高、
  字重、颜色与换行策略；
- 消息动作、Citation/来源、附件标题/状态、工具 shimmer、failed/cancelled Run 语义；
- 工具菜单、模型菜单、Citation 卡片、Sources drawer/column 的视口边界；
- `documentElement.scrollWidth === clientWidth`，以及根基线仍为 15/24。

诊断截图确认 320–1280px 的变化均为上述自然 reflow，没有文字裁切、菜单溢出或意外横向滚动。

## Ticket 04 入口

从 `.scratch/chatgpt-typography/issues/04-migrate-secondary-surface-typography.md` 开始，只迁移 Sidebar、
通用菜单/BottomSheet、Dialog、账户、分享、认证和其他次级状态表面。保留本票的聊天角色与生产夹具，
不要重新调整 Composer、Message、Thinking、Citation、SourcesPanel 或聊天附件。

Ticket 04 必须继续保护全部 Wordmark、助手 Markdown 和 `html/body` 旧根基线。完成 ticket 04 后才能
推进 ticket 05；当前任务到此停止，不实施 ticket 04/05，也不创建下一任务。
