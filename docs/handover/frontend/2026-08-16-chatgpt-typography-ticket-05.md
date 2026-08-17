# ChatGPT 文字系统 ticket 05 交接

- 日期：2026-08-16
- 分支：`fix/sidebar-scrollbar`
- 范围：`.scratch/chatgpt-typography/` 的 ticket 05；下一步只从 ticket 06 进入。

## 当前状态

Ticket 05 已完成。`html/body` 已从 Inter / 15px / 1.6 切换到 ChatGPT UI 栈 / 16px / 1.5，
computed 根行高继续为 24px；tickets 01–04 的品牌、助手、聊天核心、次级表面和长文本基线均通过。

本次继续使用 tickets 01–04 的未提交工作区，没有创建 worktree、分支或提交，也没有实施 ticket 06。
PRD frontier 已推进到 ticket 06：

- `.scratch/chatgpt-typography/PRD.md`
- `.scratch/chatgpt-typography/reference-matrix.md`
- `.scratch/chatgpt-typography/issues/06-visual-acceptance-and-documentation.md`

## 根基线与品牌保护

- `html/body` 现在显式使用 `var(--font-ui)`、16px、1.5（computed 24px）和
  `--color-type-primary`，`--font-sans` 不再承担普通 UI 根字体。
- Wordmark 与 AuthScreen 标题的品牌字体规则集中在 `global.css` 的 `.wordmark` 和
  `.auth-brand-title`；Wordmark 的动态 `fontSize` prop 是唯一允许的 inline font metric。
- 通用 Wordmark 显式保留 1.6 行高，因此 18px/20px 变体仍为 28.8px/32px；AuthScreen 22px
  标题仍为 35.2px。`.sidebar-desktop .wordmark` 继续继承 UI 栈并显式保持 24px 行高。
- Playwright 继续断言所有品牌变体的 family、size、line-height、weight、spacing、transform、color
  和 bounding box。根切换没有通过继承改变品牌几何。

## 允许的字体例外

生产字体 family 的允许清单集中记录在 `global.css` 注释，并由
`typography-system.visual.ts` 的 computed-style 契约覆盖：

1. Wordmark 与 AuthScreen 独立品牌标题使用 `--font-sans`；Sidebar desktop Wordmark 保持既有
   UI 栈 scoped 例外；
2. 助手行内代码和代码块使用 `--font-code`，代码 toolbar 继续使用 UI 栈；
3. KaTeX 后代继续使用第三方 stylesheet 自带的 `KaTeX_*` family。

除此之外，Sidebar、助手 Markdown 根、页面、表单、控件和状态均使用或继承 `--font-ui`。
代码 toolbar/copy/run/table header 中冗余的 `font-family: inherit` 已移除；Auth 与 Sidebar 中的
`font-[inherit]` 也已移除。

## 机械审计结果

对 `frontend/src` 完成逐消费者审计：

- `text-[…px]`：0；
- `leading-[…]`：0；
- 10.5px、11.5px、12.5px、13.5px：0；
- `max-[…]:text-[…]` 或其他响应式字号差异：0；
- `font-[…]`：0；
- 组件级 `font-sans`：0；`--font-sans` 只由两个品牌选择器消费；
- inline font style：仅 `Wordmark.tsx` 的品牌尺寸 prop；
- 显式 production rem：0；唯一源码命中是 `codeHighlight.test.ts` 中用于高亮输入的 CSS 样本文本，
  不会进入应用样式。

`#1a1a19`、`#6b6a66`、`#95938e`、`#b8b6b0` 的源码命中只剩 `@theme` 中既有 surface、accent、
brand 和兼容 alias 定义。普通正文的旧直接消费者已移除；仍出现的 `text-text-*` / `text-fg-*`
class 均只给图标、加载 glyph、品牌或无文字 skeleton 着色，未作为业务文字前景。

## root/rem 漂移修复

切换前用真实 Chromium 锁定：body 15/24、`text-lg` 16.875/26.25px、`rounded-xl` 11.25px，
Composer 的 `5rem` 下限为 75px。切换后采取以下最小兼容修复：

- `--spacing` 和所有语义 type token 继续是固定 px；
- `--text-lg` / line-height 固定为 16.875/26.25px，保护 Account 头像首字母；
- `--radius-xl` 固定为 11.25px，保护附件、warning 与退出确认表面；
- Composer 高度下限改为 `max(30svh, 75px)`，保持原实际 px；
- UserMenu 原 10px 头像首字母是唯一不符合矩阵的消费者，现按小/中 12/16 Meta、大 14/20 UI
  角色呈现；24/32/40px 头像盒和所有触摸目标不变。

production CSS 已不再输出被消费的 `1.125rem` 与 `.75rem`。剩余 rem 仅为 Tailwind 未被生产
class 消费的 `.rounded` 扫描项，以及标准 media/container 断点；它们不随页面根字号造成消费者漂移。

## 视觉证据与验证

`frontend/tests/visual/typography-system.visual.ts` 在 320、375、390、414、768、1280px 逐档验证：

- root 为 UI / 16/24，语义 type/spacing 与兼容 utility 输出固定 px；
- Composer、Message、Thinking、Citation、Sources、附件、Run/tool 状态无裁切或页面级横向 overflow；
- Sidebar、UserMenu、Popover/BottomSheet、表单、状态和长文本保持同角色、触摸目标与自然回流；
- Wordmark/Auth、助手 Markdown、代码/KaTeX 字体例外和次级页面保持保护值。

切换前后诊断图已人工对照。1280 聊天核心、Account 和完整品牌/角色截图文件哈希完全一致；
320px 等窄屏仅出现矩阵要求的头像首字母 10→12px，不改变容器、触摸目标或业务行为。

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
```

结果：Vitest 74 files / 634 tests；Playwright 28 passed / 20 expected skips；lint、typecheck 和
production build 通过。Lint 只报告既有 `authFields.tsx` Fast Refresh warning，build 只报告既有
large chunk 提示；仓库根目录 `git diff --check` 通过。

## Ticket 06 入口

从 `.scratch/chatgpt-typography/issues/06-visual-acceptance-and-documentation.md` 开始。Ticket 06 仍需按
其独立 acceptance criteria 完成最终角色覆盖、1280×800 与 200% zoom、对比度/焦点/错误信息检查，
并更新 `docs/architecture/frontend.md` 的文字系统维护规则与 PRD 最终状态。

继续以本票的 16/24 根基线、集中字体例外、机械审计零命中和 tickets 01–04 的 computed-style/
screenshot 为保护区。当前任务到此停止，不实施 ticket 06，也不创建下一任务。
