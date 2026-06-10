# 目标：前端样式 Tailwind CSS v4 重构

日期：2026-06-10
分支：`refactor/frontend`
承接：`docs/handover/frontend/2026-06-10-frontend-toast-and-bottomsheet.md`（步骤 11 已完成）

## 目标陈述

把 `frontend/` 现有约 1,500 行手写 CSS（`src/styles/tokens.css` 52 行 / `src/styles/global.css` 30 行 / `src/styles/chat.css` 1,055 行 / `src/auth/AuthScreen.css` 381 行）重构为 **Tailwind CSS v4**：采用 CSS-first 配置（`@theme` 定义设计令牌，无 `tailwind.config.js`），通过 `@tailwindcss/vite` 插件接入构建；组件样式以 **utility class 写进 JSX**（官方推荐风格），语义类名仅作为测试 / 运行时 JS 的钩子保留，不再承载样式；最终删除 `chat.css`、`AuthScreen.css`、`tokens.css`。

这是**纯样式载体重构**——视觉外观与交互行为保持不变，不做重新设计、不加深色模式、不改任何组件逻辑、状态层与 API 层。

## 范围

### 包含

1. **依赖与构建接入**：`tailwindcss@^4` + `@tailwindcss/vite`（devDependencies，pnpm 安装）；`vite.config.ts` 注册插件（当前 Vite 5.4.21 满足插件 peer 要求）。
2. **单一 CSS 入口**（`src/styles/global.css`）：`@import "tailwindcss"` + `@theme` 把 `tokens.css` 现有令牌迁入（颜色、圆角、字体族），使 `bg-bg`、`text-fg-muted`、`border-border` 等 utility 可用；非颜色的布局变量（`--reading-width`、`--sidebar-width`、`--density` 派生 padding 等）可保留为普通 CSS 变量由 arbitrary value 引用。
3. **全部组件 JSX 改写为 Tailwind utilities**：`AppShell`、`Sidebar`、`Topbar`、`Message`、`MessageThread`、`StreamingMessage`、`ThinkingBlock`、`MessageAction`、`Composer`、`ConfirmDialog`、`Toast`、`BottomSheet`、`AuthScreen`、`AuthBackground`、`Markdown` 容器、`Wordmark`。
4. **语义类名作为标记保留**（与 utilities 并存于 className，本身不再有样式规则；详见「已有契约与桩点」清单）。
5. **白名单内的少量手写 CSS** 保留在入口文件：
   - `.md` Markdown 排版块（react-markdown 渲染产物，无法逐元素加 utility）；
   - `::-webkit-scrollbar` 系列伪元素；
   - `@keyframes`（`skel` / `sheet-in` / `toast-in` / `auth-drift-1..3`，或迁入 `@theme` 的 `--animate-*`）；
   - 全局 `:focus-visible` 规则与 `button/input/textarea` 重置（base 层）；
   - AuthScreen 的 grain / grid data-URI 背景（`.auth-grain` / `.auth-grid`）。

   白名单之外不得新增语义类样式规则。

### 不包含（明确留给后续）

- 任何视觉改版：颜色、间距、字号、圆角、动画时长均维持现值。
- 深色模式、新组件、新交互。
- 组件逻辑、状态层（reducer/hooks）、API 层改动——仅 className 与样式文件变更。
- `--density` 派生变量体系的重新设计（保留 CSS 变量直接引用即可）。
- 测试断言语义的改动（仅允许因 className 合并产生的 trivial 调整，且不得删除下列 querySelector 钩子）。

## 已有契约与桩点（不需新建，直接接入）

- **构建链**：Vite 5.4.21 + `@vitejs/plugin-react`；`vite.config.ts` 同时是 vitest 配置（`test.css: true`）。若 Tailwind 插件拖慢 jsdom 测试，可评估在测试中关闭 css 处理（测试只查询类名、不断言计算样式）。
- **样式入口**：`src/main.tsx` 导入 `./styles/global.css`；`src/app/AppShell.tsx:20` 导入 `../styles/chat.css`；`src/auth/AuthScreen.tsx:6` 导入 `./AuthScreen.css`。重构后只保留 main.tsx 一处导入。
- **测试 / 运行时 JS 依赖的选择器钩子**（grep 自 `src/**/*.{ts,tsx}`，**必须保留**）：
  - `closest(".msg")`（useStickToBottom 滚动定位）；
  - `querySelector`：`.body.md`、`.history-menu`、`.msg-actions`、`.sheet`、`.sheet-backdrop`、`.sheet-handle`、`.status-pill.failed`、`.status-pill.stopped`、`.thinking`、`.thread-region`、`.title-skeleton`、`.toast`；
  - 条件状态类（测试断言其出现/消失）：`.msg.user` / `.msg.assistant`、`.sidebar.collapsed` / `.sidebar.open`、`.welcome-section.hidden`、`.composer-animate`、`.scrim.show`、`.history-row.active`、`.thinking.collapsed`、`.copy-swap[data-copied]`、`.msg-actions.resident`。
- **设计令牌**（`tokens.css` → `@theme` 映射源）：`--bg/--bg-sunken/--bg-raised/--bg-hover/--bg-active`、`--fg/--fg-muted/--fg-subtle/--fg-faint`、`--border/--border-strong/--border-focus`、`--accent/--accent-fg/--accent-soft`、`--danger/--danger-soft`、`--radius-sm/--radius/--radius-lg`、`--font-sans/--font-mono/--font-serif`、滚动条色。
- **测试基线**：`pnpm exec vitest run` 当前 **43 文件 / 233 用例全绿**。
- **质量门命令**（`frontend/package.json` scripts）：`pnpm exec vitest run` / `pnpm run typecheck` / `pnpm run lint` / `pnpm run build`。
- **移动断点**：CSS `@media (max-width: 760px)` 与 JS `useIsMobile()`（< 760）一致；Tailwind 写法用自定义断点（如 `max-md` 自定义为 760px 或 arbitrary variant `max-[760px]:`），不得改变断点值。

## 验收标准

### A. 接入

- A1. `frontend/package.json` devDependencies 含 `tailwindcss@^4` 与 `@tailwindcss/vite`；`vite.config.ts` 注册插件；`pnpm install` 后 lockfile 更新。
- A2. `src/styles/global.css` 以 `@import "tailwindcss"` 开头，`@theme` 内含上述全部色板 / 圆角 / 字体令牌（值与 `tokens.css` 现值逐一相等）。
- A3. `pnpm run build` 成功，产物 CSS 含 Tailwind 生成的 utilities（可由 `dist/assets/*.css` 中存在如 `.flex{display:flex}` 之类的 utility 规则验证）。

### B. 迁移完成度

- B1. `src/styles/chat.css`、`src/styles/tokens.css`、`src/auth/AuthScreen.css` 三个文件已删除，无任何残留 import。
- B2. 仓库 `frontend/src` 内手写 CSS 仅剩 `src/styles/global.css` 一个文件；其中 `@theme` 块之外的自定义规则 **≤ 300 行**，且每条规则属于「范围-包含-5」白名单类别。
- B3. JSX 中除「契约清单」所列标记类外，无引用已删除样式表中类名却未配 utility 的"裸类"（即所有视觉样式均来自 utilities 或白名单 CSS）。

### C. 行为零回归

- C1. 契约清单中全部选择器钩子在 DOM 中仍存在，且按原条件切换（collapsed / open / hidden / active / resident / data-copied 等），由既有 233 个测试直接覆盖。
- C2. 既有测试文件的断言语义不变：不删除、不放宽上列 querySelector / closest 断言；仅允许 className 串内容变化引起的 trivial 调整。

### D. 质量门（全绿才算完成）

- D1. `pnpm exec vitest run` 全部通过，用例数 **≥ 233**。
- D2. `pnpm run typecheck` 通过。
- D3. `pnpm run lint` 通过。
- D4. `pnpm run build` 通过。

### E. Chrome 手动视觉比对（人工，Tier 2）

- E1. 桌面视口：登录页（含 blob 漂移动画、grain/grid 背景、tab 下划线）、侧栏（展开/收起动画、行 hover 菜单、就地重命名、标题骨架屏）、消息流式（thinking 折叠、状态 pill、hover 操作条、复制图标切换）、Composer（居中→落底过渡、send/stop 按钮）、ConfirmDialog、Markdown（代码块/表格/引用）逐屏与重构前一致。
- E2. 移动视口（≤760px）：侧栏抽屉 + scrim、消息「更多」BottomSheet、侧栏行 BottomSheet、Toast 位置与动画一致。

## 预期实现路径（advisory，非强制）

- 先接入（A1–A3）并把 `tokens.css` 内容迁入 `@theme`，此时旧 CSS 与 Tailwind 共存、页面不变，跑一遍质量门确认共存无冲突。
- 然后**按组件逐个迁移、逐个提交**，每迁一个组件即删除 `chat.css` / `AuthScreen.css` 中对应规则段，跑该组件测试；建议顺序：叶子组件（Toast、BottomSheet、ConfirmDialog、MessageAction、ThinkingBlock、Wordmark）→ Message / StreamingMessage / Markdown 容器 → Composer → Sidebar / Topbar → AppShell（welcome / composer-animate 过渡）→ AuthScreen / AuthBackground。
- 条件类（如 `sidebar.collapsed`）的样式改由 utility 变体表达：父级标记类 + `group-data-*`、或三元拼 className（项目无 clsx，可直接模板串或新增小工具函数）。
- `composer-animate` 等"父级开关控制子级 transition"的规则**不**进白名单：用 Tailwind 任意变体（如 `[.composer-animate_&]:transition-[flex-grow]`）或在子元素上按状态条件拼接 utility 实现。
- 动画：`@theme` 中声明 `--animate-sheet-in` 等 + `@keyframes`，JSX 用 `animate-sheet-in`。
- 迁移期间随时可跑全量质量门；最后做 B1/B2 的删除与收口。

## 验证命令

```bash
cd frontend
pnpm install             # 锁定 tailwind v4 依赖后
pnpm exec vitest run     # 全绿，≥ 233
pnpm run typecheck
pnpm run lint
pnpm run build
```

## 完成边界（Definition of Done）

### Tier 1 —— 自主完成条件（/goal 判定依据）

当且仅当以下全部成立：

1. 验收标准 **A、B、C、D** 全部满足（D 四道质量门命令在转录中可见全绿；B1/B2 可由文件不存在 + 行数统计验证）。
2. 写出交接文档 `docs/handover/frontend/2026-06-10-frontend-tailwind-v4-styles.md`，含：改动概览、令牌映射表（旧 var → @theme/utility）、白名单 CSS 清单及理由、关键决策（条件类的变体写法等）、四道质量门输出、遗留边界。
3. 工作树干净，按组件/单元逐步提交。

### Tier 2 —— 人工验收清单（循环报告完成后由用户执行）

- 验收标准 **E**（桌面 + 移动视口逐屏视觉比对、动画手感）。
- 如发现视觉回归，记录差异点开后续修复目标，不回滚本重构。

未达成 Tier 1 任一条即视为未完成，保持 in_progress 并记录阻塞点。

## 关联文档

- 前序目标：`docs/goals/2026-06-10-frontend-toast-and-bottomsheet.md`
- 前序交接：`docs/handover/frontend/2026-06-10-frontend-toast-and-bottomsheet.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
