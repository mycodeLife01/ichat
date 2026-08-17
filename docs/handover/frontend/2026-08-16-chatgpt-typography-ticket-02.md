# ChatGPT 文字系统 ticket 02 交接

- 日期：2026-08-16
- 分支：`fix/sidebar-scrollbar`
- 范围：`.scratch/chatgpt-typography/` 的 ticket 02；下一步只从 ticket 03 或 04 进入。

## 当前状态

Ticket 02 已完成，`.scratch/chatgpt-typography/PRD.md` 的 frontier 已推进到可并行领取的 03、04。
权威需求、冻结值与下一票入口位于：

- `.scratch/chatgpt-typography/PRD.md`
- `.scratch/chatgpt-typography/reference-matrix.md`
- `.scratch/chatgpt-typography/issues/03-migrate-chat-core-typography.md`
- `.scratch/chatgpt-typography/issues/04-migrate-secondary-surface-typography.md`

本次直接在 ticket 01 的未提交工作区上继续，没有创建 worktree、分支或提交，也没有开始迁移
ticket 03/04 的生产业务 JSX。

## 本次落地

### 令牌与字体职责

`frontend/src/styles/global.css` 现在提供：

- 精确按冻结矩阵排列的 `--font-ui` ChatGPT 系统字体栈；
- 独立的 14/20 UI、12/16 Meta、18/28 surface title、16/26 Composer/助手、16/24
  用户消息/思考，以及 Markdown 标题、列表、引用、表格、inline code、code toolbar/code text
  尺度令牌；
- 400/500/600/700 四档显式字重；
- `type-primary`、`type-secondary`、`type-tertiary`、`type-disabled` 和
  `type-user-message` 文字颜色；
- 清晰的字体例外边界：`--font-sans` 是 iChat 品牌栈并暂时继续承担根迁移基线，等宽代码与
  明确衬线内容使用内容专用栈，KaTeX 继续拥有数学字形。

`--font-code` 单独冻结助手代码当前已对齐的
`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`
顺序；既有 `--font-mono` 值不变，避免 ticket 02 间接改变尚未迁移的 AuthScreen 装饰文字。

### 共享角色

`frontend/src/ui/classes.ts` 新增最小共享 seam：

- `uiText`、`uiLabel`、`metaText`、`surfaceTitle`、`controlText`；
- `formLabel`、`formValue`、`formHelp`；
- `composerText`、`composerPlaceholder`、`composerMode`、`composerMenuItem`；
- `userMessageText`、`assistantText`、`reasoningCollapsed`、`reasoningText`；
- attachment/source 标题与 Meta 别名，以及不绑定 tone 颜色的状态密度角色。

相同尺度通过语义别名复用同一 class 组合，没有为页面复制新组合。角色同时固化参考矩阵中的
letter-spacing、换行、断词和省略策略；Markdown 产物仍由窄作用域 CSS 消费底层令牌。

### 无视觉变化的消费面

- `.assistant-markdown` 的正文、H1–H6、列表、链接、引用、inline code、code toolbar/code text、
  表格和相关前景色已从硬编码值改为消费新令牌，computed style 与 assistant golden 不变。
- `.sidebar-desktop` 的系统字体、16/24 根行盒、primary/tertiary 映射改为消费相同令牌；会话行、
  分组标题和完整生产 Sidebar 基线保持不变。
- `frontend/tests/visual/typography-system.*` 新增 token、根基线和共享角色 computed-style 断言，
  desktop/mobile 诊断截图继续覆盖品牌变体、已对齐区和长文本；这些文件仍不进入生产路由或构建入口。

## 冻结边界

- `html/body` 仍为 `font-family: var(--font-sans)`、15px、1.6（computed 24px）根行盒；切换根基线
  必须等待 ticket 05。
- `frontend/src/ui/Wordmark.tsx` 与 AuthScreen 22px 品牌标题未修改；普通 18px、移动 20px 和
  AuthScreen 22px 的字体、行高、字重、字距、transform、颜色与 bounding box 均保持 ticket 01 基线。
- `.sidebar-desktop .wordmark` 继续 `font-family: inherit`，因此保持桌面 Sidebar 系统字体的冻结
  scoped 例外；它没有被“修正”为 Inter。桌面收起 rail 仍无可见 Wordmark。
- 未修改 Composer、Message、ThinkingBlock、Sidebar 等生产 JSX 的任意字号；它们分别属于
  ticket 03/04。没有改圆角、表面色、图标、动效、业务行为、API、Run 或后端契约。

## UI system 09 重叠检查

`.scratch/ui-system-unification/issues/09-conformance-and-visual-acceptance.md` 当前仍为
`ready-for-agent`，其 01–08 前置已完成。该票未来也会读取 `global.css`、`classes.ts` 与视觉 fixture，
但字体体系在其 PRD 中明确为范围外；本票只新增 `type-*` typography 命名空间并保留既有
surface/status token，没有当前未提交文件冲突。若 09 后续开始，应保留本票令牌并只执行其全局
合规、状态与可访问性收口。

## 验证

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
```

结果：Vitest 74 files / 634 tests；Playwright 8 passed / 2 configured skips；lint、typecheck 和
production build 通过。Vite 只有项目既有的大 chunk 提示，不影响退出码。仓库根目录的
`git diff --check` 也通过。

Playwright 同时证明：

- `--font-ui` 回退顺序与颜色/尺度令牌精确匹配 reference matrix；
- 共享角色在 desktop/mobile 获得对应 font family、size、line-height、weight、letter-spacing、
  color 与 wrap 策略；
- assistant final/stream/share、Markdown 标题/列表/表格/代码、生产 Sidebar 和所有 Wordmark
  computed style 无回归；页面无意外水平 overflow。

## 下一票入口

- Ticket 03：从 `.scratch/chatgpt-typography/issues/03-migrate-chat-core-typography.md` 开始，迁移
  Composer、用户/助手消息、ThinkingBlock、引用、来源、附件与 Run 状态；助手 Markdown 是保护区。
- Ticket 04：从 `.scratch/chatgpt-typography/issues/04-migrate-secondary-surface-typography.md` 开始，
  迁移 Sidebar、菜单、Dialog、账户、分享、认证和状态表面；所有 Wordmark 是保护区。

03 与 04 可以并行，但不能同时修改同一个 `classes.ts` 原语；任何共享角色扩展应先协调唯一所有者。
两票都不得切换 `html/body` 根基线，ticket 05 必须等待 03、04 全部完成。当前任务到此停止，不实施
03/04，也不创建下一任务。
