# 2026-06-10 前端样式 Tailwind CSS v4 重构 交接文档

## 本次完成

完成 `docs/goals/2026-06-10-frontend-tailwind-v4-styles.md` 的全部 Tier 1 目标：把 `frontend/` 约 1,518 行手写 CSS（`tokens.css` 52 / `global.css` 30 / `chat.css` 1,055 / `AuthScreen.css` 381）重构为 **Tailwind CSS v4**。纯样式载体重构——视觉外观、交互行为、组件逻辑、状态层与 API 层全部不变。

- **接入**：`tailwindcss@4.3.0` + `@tailwindcss/vite@4.3.0`（devDependencies），`vite.config.ts` 注册插件（Vite 5.4.21 满足 peer 要求）。CSS-first 配置，无 `tailwind.config.js`。
- **令牌**：`tokens.css` 全部色板 / 圆角 / 字体迁入 `src/styles/global.css` 的 `@theme`；`chat.css` 与 `AuthScreen.css` 的全部组件规则改写为 JSX 内 utility class；三个旧 CSS 文件已删除。
- **最终形态**：`frontend/src` 仅剩一个样式文件 `src/styles/global.css`（280 行，含 `@theme` 112 行 + 白名单自定义规则约 160 行，远低于「@theme 之外 ≤ 300 行」上限），由 `main.tsx` 单点导入。

按组件逐步提交，共 6 个提交（`56e5b55` 接入 → 叶子组件 → 消息层 → shell/侧栏/composer → auth → 收口）。

## 质量门（全绿）

```
pnpm exec vitest run   → 43 文件 / 233 用例全部通过（基线 233，无测试改动）
pnpm run typecheck     → 通过
pnpm run lint          → 通过
pnpm run build         → 通过（dist CSS 33.79 kB，含 Tailwind utilities，
                          以 .flex{display:flex} 存在性验证）
```

既有测试的断言语义零改动（`*.test.*` 文件未动），全部选择器钩子按原条件切换。

## 令牌映射表（旧 var → @theme / utility）

| 旧令牌（tokens.css） | @theme 变量 | utility 示例 |
|---|---|---|
| `--bg` / `--bg-sunken` / `--bg-raised` | `--color-bg(-sunken/-raised)` | `bg-bg`、`bg-bg-sunken`、`bg-bg-raised` |
| `--bg-hover` / `--bg-active` | `--color-bg-hover/-active` | `hover:bg-bg-hover`、`bg-bg-active` |
| `--fg` / `--fg-muted` / `--fg-subtle` / `--fg-faint` | `--color-fg(-muted/-subtle/-faint)` | `text-fg`、`text-fg-muted` … |
| `--border` / `--border-strong` / `--border-focus` | `--color-border(-strong/-focus)` | `border-border`、`border-border-strong` |
| `--accent` / `--accent-fg` / `--accent-soft` | `--color-accent(-fg/-soft)` | `bg-accent`、`text-accent-fg` |
| `--danger` / `--danger-soft` | `--color-danger(-soft)` | `text-danger`、`bg-danger-soft` |
| `--radius-sm` 4px / `--radius` 6px / `--radius-lg` 10px | `--radius-sm/-md/-lg`（覆盖默认刻度） | `rounded-sm` = 4px、`rounded-md` = 6px、`rounded-lg` = 10px |
| `--font-sans/-mono/-serif` | 同名 `--font-*` | `font-sans`、`font-mono`（preflight 默认字体随之生效） |
| `--reading-width` / `--sidebar-width` | 保留为 `:root` 普通变量 | `max-w-[var(--reading-width)]` |
| `--scrollbar-thumb(-hover)` | 保留为 `:root` 普通变量 | 仅白名单滚动条 CSS 引用 |
| `--density` 1.1 及派生（`--row-pad-*`、`--msg-gap`） | **内联为计算值** | `px-[11px] py-[7.7px]`（行）、`gap-[35.2px]`（消息间距） |
| `--composer-radius` 18px、`--send-radius` 18px、`--user-bubble-radius` 10px、`--menu-radius` 8px、`--history-radius` 6px、`--composer-border-width` 1px | **内联为字面值**（Tweaks 遗留，运行期不变） | `rounded-[18px]`、`rounded-[10px]`、`rounded-md` … |

动画迁入 `@theme`：`--animate-toast-in` / `--animate-sheet-in` / `--animate-skel` / `--animate-auth-drift-1..3`（`@keyframes` 嵌于 `@theme`），JSX 用 `animate-toast-in` 等。

## 白名单 CSS（global.css 中 @theme 之外的自定义规则）

均为 utility 无法表达或不值得逐元素表达的类别（目标文档「范围-包含-5」）：

1. **`.md` Markdown 排版块**（react-markdown 渲染产物，无法逐元素加 class）+ `.tok-*` 语法高亮色。
2. **`::-webkit-scrollbar` 系列伪元素** + `* { scrollbar-width/color }`。
3. **全局 `:focus-visible`** 轮廓与 `button/input/textarea` 的 `font/color` 继承、`button { cursor:pointer }`（Tailwind v4 preflight 不再设按钮指针）。
4. **`.auth-grain` / `.auth-grid`**：data-URI 噪点与遮罩网格背景（URI 内联进 JSX 不可读）。
5. `html/body/#root` 基础规则（高度、15px 基准字号、字体平滑）。

## 关键决策

- **语义类名仅作钩子**：测试 / 运行时 JS 依赖的选择器全部保留且不再承载样式——`.msg(.user/.assistant)`、`.body.md`、`.history-menu`、`.msg-actions(.resident)`、`.sheet/.sheet-backdrop/.sheet-handle`、`.status-pill.stopped/.failed`、`.thinking(.collapsed)`、`.thread-region`、`.title-skeleton`、`.toast`、`.sidebar(.collapsed/.open)`、`.scrim(.show)`、`.history-row(.active)`、`.copy-swap[data-copied]`、`.welcome-section`、`.composer-animate`、`.app`、`.main`、`.composer`、`.composer-wrap`、`.thread-inner`、`.dialog(-backdrop)`、`.wordmark`。
- **`.welcome-section.hidden` 的 `hidden` 例外**：Tailwind v4 中 `hidden` 是真实 utility（`display:none`），若按原样保留会杀掉 max-height 渐隐过渡，故折叠态改用 `max-h-0 opacity-0 pointer-events-none` 表达、不再输出字面 `hidden` 类。无测试断言该类，行为与视觉不变。
- **条件状态全部在 JSX 分支**：`collapsed/open/active/resident` 等原 CSS 后代选择器改为 React 状态驱动的条件 utility（如侧栏桌面收起 `w-0`、移动抽屉 `-translate-x-full`），状态类名仅作标记附加。
- **`composer-animate` 用任意变体表达父级开关**：子元素写 `[.composer-animate_&]:[transition:...]`，保持「仅新会话首条消息动画」的门控语义（AppShell 注释保留）。
- **悬停显隐用 `group`**：`.msg:hover .msg-actions` → `group` + `group-hover:opacity-100 group-focus-within:opacity-100`；侧栏行菜单按钮用命名 `group/row`。
- **共享样式抽为常量**（`src/ui/classes.ts`）：`iconBtn` / `ghostBtn` / `primaryBtn` / `msgAction` / `sheetItem` / `titleSkeleton`，跨组件复用不走 `@apply`。
- **保真修正两处**（与原 CSS 行为逐像素一致）：active 行悬停仍显示 `bg-bg-active`（hover utility 只加在非 active 分支）；`.toast` / tooltip 的水平居中用 `[transform:translateX(-50%)]` 而非 `-translate-x-1/2`（v4 的 translate 属性会与 keyframes 的 `transform` 叠加导致入场动画双重位移）。
- **preflight 接管元素重置**：旧 `* {box-sizing}`、按钮/输入框 reset 删除，由 v4 preflight 提供。preflight 的 `ol,ul,menu {list-style:none}` 会吃掉 Markdown 列表符号（产物 CSS 中已确认存在该规则），故 `.md` 白名单块显式恢复 `.md ul {list-style:disc}` / `.md ol {list-style:decimal}`，缩进由既有 `padding-left:22px` 保持。
- **媒体断点**：CSS `@media (max-width:760px)` 改为 `max-[760px]:` 任意变体（与 JS `useIsMobile()` 的 760 一致）；侧栏/scrim 的移动形态由 `isMobile` prop 分支（与原行为等价，且这两处本就由 JS 控制渲染）。

## 已知边界 / 遗留

- **未做视觉改版**：所有颜色、间距、字号、动画时长与重构前一致；深色模式仍不支持。
- **死代码顺带消失**：`.wordmark .dot`、`.welcome-pills/.welcome-pill`、`.mobile-only/.desktop-only`、`.thread`、`.auth-title` 等原 CSS 中无 JSX 消费者的规则未迁移（属于删除文件的一部分，非主动清理）。
- **Sidebar 行内菜单**（`.history-menu`）原本就是 inline style + 类名混合，本次把 inline style 收敛为 utility（仅 `rowActions` 的 item 内边距仍走 style prop，与原实现一致）。
- **vitest `css: true` 保留**：Tailwind 插件在测试管线中无感（12s 量级不变），未做特殊处理。
- Tier 2 人工视觉比对（桌面/移动逐屏、动画手感）留给用户执行，见目标文档验收标准 E。

## 验证命令

```bash
cd frontend
pnpm install
pnpm exec vitest run     # 43 文件 / 233 用例全绿
pnpm run typecheck
pnpm run lint
pnpm run build
```

## 关联文档

- 目标：`docs/goals/2026-06-10-frontend-tailwind-v4-styles.md`
- 前序交接：`docs/handover/frontend/2026-06-10-frontend-toast-and-bottomsheet.md`
