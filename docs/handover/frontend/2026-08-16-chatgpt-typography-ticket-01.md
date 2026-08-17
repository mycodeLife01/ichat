# ChatGPT 文字系统 ticket 01 交接

- 日期：2026-08-16
- 分支：`fix/sidebar-scrollbar`
- 范围：`.scratch/chatgpt-typography/` 的 ticket 01；下一步只实施 ticket 02。

## 当前状态

Ticket 01 已完成，`.scratch/chatgpt-typography/PRD.md` 的 frontier 已推进到 02。权威需求、验收项与
同日实测值分别位于：

- `.scratch/chatgpt-typography/PRD.md`
- `.scratch/chatgpt-typography/issues/02-establish-typography-tokens.md`
- `.scratch/chatgpt-typography/reference-matrix.md`

本 ticket 只建立参考证据、visual fixture 与断言，没有修改 `frontend/src` 下的生产样式或组件。
当前工作区包含本系列尚未提交的 ticket 01 变更，后续任务必须保留并在其上继续，不能回退或覆盖。

## 冻结的参考结论

2026-08-16 在 macOS Chrome 151 中采样了已登录 ChatGPT 普通会话、富 Markdown、用户消息、
Composer、模式菜单、思考折叠/展开态、Sidebar、Popover、Dialog 和表单状态。ChatGPT 采样页最终
viewport 为 1470×741 CSS px、DPR 2、100% zoom；本地 iChat 基线使用 1280×800、DPR 1、100%
zoom。完整 URL、状态、字体栈、字号、行高、字重、颜色、换行与截断规则见 reference matrix。

需要特别保留的决定：

- 非品牌 UI 字体栈为
  `-apple-system-body, ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"`。
- primary 为 `#0d0d0d`，secondary 为 `#5d5d5d`，tertiary/placeholder 为 `#8f8f8f`，
  disabled 基线为 `#b4b4b4`，用户消息为 `#0c274a`。
- Composer 输入为 16/26；当前模式触发器同为 16/26，但颜色是 tertiary，不是规划期假定的 primary。
- 页面/Dialog section 标题补充为 18/28、400；普通 UI/菜单为 14/20，meta 为 12/16。
- 助手正文 16/26 和桌面 Sidebar 14/20 已经对齐，只允许令牌化，computed style 与截图必须不变。
- 品牌边界保持现状：普通 Wordmark 使用 Inter 品牌栈；桌面 Sidebar 展开字标实际为 18px 且继承
  Sidebar 系统字体，收起 rail 没有可见字标，移动抽屉为 20px。`.sidebar-desktop .wordmark` 是冻结的
  scoped 例外，不能在 ticket 02 顺手改回 Inter。
- AuthScreen 22px 独立品牌标题、SharePage、VerifyEmailPage、ResetPasswordPage 与
  ConfirmAccountDeletionPage 的字标度量均已固化。

## 本次落地

- 新增 `.scratch/chatgpt-typography/reference-matrix.md`，目标角色全部有直接或最近 ChatGPT 角色映射，
  无 TBD。
- 新增 `frontend/tests/visual/typography-system.{html,tsx,css,visual.ts}`，集中展示所有品牌变体、
  已对齐助手/Sidebar 基线，以及中文、英文、数字、标点、emoji、长单词与长 URL 压力样本。
- 扩展 `frontend/tests/visual/sidebar-scroll.visual.ts`，记录生产 Sidebar 与字标的 computed typography
  和边界；断言兼容 macOS overlay scrollbar。
- `frontend/tests/visual/thread-bottom.visual.ts` 仅做测试环境兼容：接受 Chromium 对同一 sRGB 颜色的
  `rgba(...)` / `color(srgb ...)` 等价序列化，并容忍动画矩阵的浮点尾差；生产 CSS 未变。
- PRD 已按同日证据修正模式触发器颜色、页面/Dialog 标题角色与 Sidebar 品牌变体描述。

## 验证记录

在 `frontend/` 执行并通过：

```bash
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
```

结果：Vitest 74 files / 634 tests；Playwright 8 passed / 2 configured skips；lint、typecheck 和 build
通过。Vite 仍输出既有的大 chunk 提示，不影响退出码。仓库根目录的 `git diff --check` 也通过。

## Ticket 02 的实施边界

先完整阅读本交接、`docs/README.md`、`docs/architecture/frontend.md`、reference matrix、PRD 和 ticket
02，再检查 `.scratch/ui-system-unification/issues/09-conformance-and-visual-acceptance.md` 是否存在并行
冲突。只完成 ticket 02，不提前迁移 ticket 03 的聊天业务表面。

Ticket 02 的可观察成功条件是：

1. 在 `global.css` 建立 `--font-ui` 和底层字号/行高/字重/颜色令牌，在 `classes.ts` 建立最小语义角色。
2. `--font-sans`、`--font-mono`、`--font-serif`、KaTeX 与 Sidebar 字标例外职责清楚；所有品牌基线不变。
3. 只把 `.assistant-markdown` 与 `.sidebar-desktop` 的现有正确数值改为消费令牌，不切换 `html/body`
   的 15px/Inter 根基线，不批量改业务 JSX。
4. ticket 01 的 typography-system、assistant-rendering 与 sidebar visual baseline 全部保持通过。
5. 完成 ticket 02 issue/PRD 状态更新，写入下一份
   `docs/handover/frontend/2026-08-16-chatgpt-typography-ticket-02.md` 后停止，等待新 Codex 任务接票 03。

## 建议验证

```bash
cd frontend
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visual
git diff --check
```
