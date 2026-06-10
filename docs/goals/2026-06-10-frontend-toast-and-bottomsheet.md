# 目标：前端步骤 11 —— Toast 失败反馈 / 移动端 BottomSheet 操作面板

日期：2026-06-10
分支：`refactor/frontend`
承接：`docs/handover/frontend/2026-06-10-frontend-edit-regenerate-and-auto-title.md`（步骤 10 已完成）
总计划：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`（实施顺序第 11 步）

## 目标陈述

把步骤 8–10 中「失败仅 `console.error` + 优雅降级」的瞬时操作补上**中文 Toast 反馈**，并为**移动端**补上消息操作与侧栏行操作的**底部操作面板（BottomSheet）**——桌面端 `.msg-actions` 仅在 `:hover`/`:focus-within` 显形、侧栏行操作走 `.history-menu` 下拉，二者在触屏上均不可达。本步移植 demo 的 `.toast` 与 `.sheet-*` 视觉资产到生产 React 组件，不新增后端 API、不改 run 生命周期。

完成本步后，重构总计划仅剩步骤 12–13（CI/CD 拆分、部署文档、Nginx/Cloudflare 配置、最终桌面/移动 smoke）。

## 范围

### 包含

1. **Toast（瞬时操作失败）**：在以下三处失败时弹出中文 Toast（短暂停留后自动消失），并保留原 `console.error`：
   - `useSendMessage` 发送失败 → 「发送失败，请重试」
   - `useRegenerate` 编辑并重发 / 重新生成失败（如 409 竞态）→ 「操作失败，请重试」
   - `useRunStream` 停止（cancel）请求失败 → 「停止失败，请重试」
2. **Toast 状态层**：`UiState` 新增 `toast`；`ui/showToast {message}`（带单调递增 id 以便同文案重复触发可重新动画）/ `ui/hideToast`；`app/reset` 清空。
3. **Toast 组件**：纯展示 `.toast`，`role="status"`，挂载后定时自动消失（计时器可注入/可被 fake timers 驱动），id 变更重新计时与重放入场动画。
4. **BottomSheet 组件**：纯展示 `.sheet-backdrop > .sheet`（含 `.sheet-handle`）；点击 backdrop 关闭、点击面板内容不关闭；关闭时不渲染。
5. **移动端消息操作 sheet**：`Message` 接 `isMobile`；移动端每条消息显示常驻「更多」按钮 → 打开 BottomSheet，列出 `复制` + （user）`编辑并重发` /（assistant）`重新生成`；遵守步骤 10 的 `mutateDisabledReason`（变更项禁用并显示原因，`复制` 始终可用）。桌面端行为不变（hover 操作条）。
6. **移动端侧栏行操作 sheet**：移动端点击行「更多」打开 BottomSheet，列出 `重命名` / `删除对话`（复用既有 `onRename` 就地输入与 `onRequestDelete` → ConfirmDialog 流程）；桌面端保留现有 `.history-menu` 下拉。

### 不包含（明确留给后续）

- run_failed / run_cancelled 的反馈：维持步骤 8 的**气泡内状态条**（`生成失败 · 请稍后重试` / `已停止`），不额外弹 Toast。
- 自动标题轮询超时/详情失败：维持步骤 10 的**静默回退「新对话」**，不弹 Toast。
- Toast 队列 / 多条堆叠 / 手动关闭按钮 / 操作型（带「重试」按钮）Toast：单条、自动消失即可。
- 桌面端消息操作或侧栏行改用 sheet：桌面端维持 hover 操作条 + `.history-menu` 下拉。
- 深色模式、ComposerState reducer 化、分支/版本树（沿用既有不包含项）。

## 已有契约与桩点（不需新建，直接接入）

- **demo 视觉资产**（`uiux_v1.html`，移植到 `frontend/src/styles/chat.css`）：
  - `.toast`：`position:fixed; bottom:80px; left:50%; transform:translateX(-50%); background:var(--fg); color:var(--bg); padding:8px 14px; border-radius:var(--radius); font-size:13px; z-index:60; animation:toast-in 200ms;`
  - `@keyframes toast-in { from{transform:translate(-50%,8px);opacity:0} to{transform:translate(-50%,0);opacity:1} }`
  - `.sheet-backdrop`：`position:fixed; inset:0; background:rgba(20,20,19,.32); z-index:40; display:flex; align-items:flex-end; justify-content:center;`
  - `.sheet`：`background:var(--bg-raised); width:100%; max-width:480px; border-top-left-radius:16px; border-top-right-radius:16px; padding:8px 0 16px; padding-bottom:max(16px,env(safe-area-inset-bottom)); animation:sheet-in 220ms cubic-bezier(.4,0,.2,1);`
  - `@keyframes sheet-in { from{transform:translateY(100%)} to{transform:translateY(0)} }`
  - `.sheet-handle`：`width:36px; height:4px; background:var(--border-strong); border-radius:99px; margin:0 auto 10px;`
  - `.sheet-item` 已存在于 `chat.css`（侧栏下拉复用）：含 `:hover/:active`、`.destructive`、`:disabled`。
- **状态层**：`UiState` 已有 `mobileSidebarOpen` / `sidebarCollapsed` / `confirmDialog`，`uiReducer` 已处理 `app/reset`；Toast 需在此扩展。
- **失败接入点**（当前仅 `console.error` 或静默）：`useSendMessage.ts:38`、`useRegenerate.ts:35`、`useRunStream.ts` 的 `cancel` catch（`run/cancelFailed`）。
- **派发入口**：三处 hook 均通过 `useAppActions()` 取 `dispatch`，可直接 `dispatch({type:"ui/showToast", ...})`。
- **isMobile**：AppShell 已有 `useIsMobile()`（`< 760`），已传给 `Sidebar`；本步额外透传给 `MessageThread → Message`。
- **图标**：`Icons` 已含 `Copy / Pencil / Refresh / Pen / Trash / More`，无需新增。
- `ConfirmDialog`、`Sidebar` 的 `onRename`（就地输入）/`onRequestDelete`（→ `ui/openConfirm`）流程已存在，sheet 仅作为移动端的另一入口复用。

## 验收标准

每条均可验证（自动化测试为主，移动端关键路径辅以 Chrome 手动 smoke）。

### A. Toast 状态层（reducer）

- A1. `ui/showToast {message}` 写入 `toast = {id, message}`，`id` 单调递增（同一 message 连续两次触发产生不同 id）。
- A2. `ui/hideToast` 置 `toast = null`。
- A3. `app/reset` 后 `toast` 为 `null`。

### B. Toast 组件

- B1. `toast` 为 null 时不渲染任何节点；非 null 时渲染含该 message 的 `.toast`，`role="status"`。
- B2. 挂载/ id 变更后经过自动消失时长（可注入计时器）触发 `onDismiss`；卸载清理计时器，不在卸载后调用 `onDismiss`。
- B3. id 变化时重新计时（前一条的计时器被清理，不会因旧计时器误关新 toast）。

### C. 失败 Toast 接入

- C1. `useSendMessage` 发送失败 → dispatch `ui/showToast {message:"发送失败，请重试"}`；原 `console.error` 保留；不崩溃、不启动流。
- C2. `useRegenerate`（编辑并重发 / 重新生成）失败 → `ui/showToast {message:"操作失败，请重试"}`；保留视图、不启动流。
- C3. `useRunStream` cancel 请求失败 → 在既有 `run/cancelFailed`（回滚乐观「停止中」）之外，dispatch `ui/showToast {message:"停止失败，请重试"}`。
- C4. 成功路径不弹任何 Toast（send 成功、cancel 成功、标题写回均无 Toast）。

### D. BottomSheet 组件

- D1. `open=false` 不渲染；`open=true` 渲染 `.sheet-backdrop > .sheet`（含 `.sheet-handle`）与传入 children。
- D2. 点击 backdrop 调 `onClose`；点击 `.sheet` 面板内容不调 `onClose`（stopPropagation）。

### E. 移动端消息操作 sheet

- E1. 桌面端（`isMobile=false`）：`Message` 维持现有 hover 操作条，**不**渲染「更多」按钮、**不**渲染 sheet（回归：桌面行为与步骤 10 完全一致）。
- E2. 移动端（`isMobile=true`）：每条消息渲染常驻「更多」按钮；点击打开 BottomSheet。
- E3. 移动端 user 消息 sheet 含 `复制` + `编辑并重发`；assistant 消息 sheet 含 `复制` + `重新生成`。
- E4. 选中 sheet 中的「编辑并重发」进入既有内联编辑（或直接触发 `onEditAndRegenerate`）；「重新生成」触发 `onRegenerate`；「复制」复制内容；选中后 sheet 关闭。
- E5. `mutateDisabledReason` 非空时，sheet 内「编辑并重发」/「重新生成」禁用并显示该原因；「复制」仍可用。

### F. 移动端侧栏行操作 sheet

- F1. 桌面端：行「更多」维持现有 `.history-menu` 下拉（重命名 / 删除对话），行为与步骤 10 一致。
- F2. 移动端：行「更多」打开 BottomSheet，含 `重命名` / `删除对话`；选中「重命名」进入既有就地输入，选中「删除对话」走既有 `onRequestDelete` → ConfirmDialog；选中后 sheet 关闭。

### G. reducer / 状态

- G1. `UiState` 新增 `toast: {id:number; message:string} | null`，初值 `null`；新增 `ui/showToast` / `ui/hideToast` 两个 action 类型并纳入 `AppAction` 联合。

### H. 质量门（全绿才算完成）

- H1. `pnpm exec vitest run` 全部通过，测试数从 **193** 继续增长（新增覆盖：toast reducer show/hide/reset + id 单调、Toast 组件渲染/自动消失/卸载清理/ id 重置计时、BottomSheet 渲染/backdrop 关闭/内容不关闭、三处失败 hook 弹 toast + 成功不弹、Message 移动端 sheet 两类操作 + 禁用态 + 桌面端回归不出 sheet、Sidebar 移动端行 sheet）。
- H2. `pnpm run typecheck` 通过。
- H3. `pnpm run lint` 通过。
- H4. `pnpm run build` 通过。

### I. Chrome 手动 smoke（Playwright MCP，移动视口为主）

- I1. 桌面视口：制造一次 cancel 失败（或 send 失败）→ 底部出现中文 Toast 并自动消失；桌面消息 hover 操作条、侧栏下拉均不变。
- I2. 移动视口（≤760）：消息「更多」→ 底部 sheet 列出复制 / 编辑并重发或重新生成；流式中变更项禁用、复制可用。
- I3. 移动视口：侧栏行「更多」→ 底部 sheet 列出重命名 / 删除对话，二者分别进入就地输入 / 确认框。

## 预期实现路径（advisory，非强制；保持与现有架构一致）

- **Toast 状态**：`ui/state.ts` 扩 `UiState.toast` + 两 action；`showToast` 用「上一条 id + 1」保证单调（reducer 内由 `state.toast?.id` 推导，避免 `Date.now`/随机源——与项目「reducer 纯函数、计时器在组件层」一致）。
- **Toast 组件**：`ui/Toast.tsx` 接 `{toast, onDismiss, duration?, setTimer?}`；`useEffect` 依赖 `toast?.id` 起 `setTimeout(onDismiss, duration)`，cleanup `clearTimeout`；测试用 `vi.useFakeTimers()` 或注入 `setTimer`。AppShell 从 `ui.toast` 渲染，`onDismiss = () => dispatch({type:"ui/hideToast"})`（用 `useCallback` 稳定引用）。
- **BottomSheet 组件**：`ui/BottomSheet.tsx` 接 `{open, onClose, children}`；`open` 假返回 null，否则 backdrop `onClick={onClose}` + 面板 `onClick={stopPropagation}`，复用 `.sheet-item` 渲染传入项。
- **失败接入**：三处 hook 在既有 catch（cancel 为 catch 内 `cancelFailed` 之后）追加一行 `dispatch({type:"ui/showToast", message})`，保留 `console.error`，更新对应 hook 测试断言 dispatch 被以该 message 调用。
- **Message 移动端**：新增 `isMobile?: boolean`；`isMobile` 时渲染「更多」按钮 + 局部 `useState` 控制的 `BottomSheet`，复用现有 `copy` / 内联编辑 / `onRegenerate`；桌面分支保持原样。`MessageThread` 透传 `isMobile`，AppShell 注入。
- **Sidebar 移动端**：`renderRow` 内 `isMobile` 时把「更多」点击改为打开 BottomSheet（复用 `menuFor` 标识当前行），桌面端维持 `.history-menu`。
- **CSS**：把上节 `.toast` / `@keyframes toast-in` / `.sheet-backdrop` / `.sheet` / `.sheet-handle` / `@keyframes sheet-in` 追加到 `chat.css`（`.sheet-item` 已存在，复用）。

## 验证命令

```bash
cd frontend
pnpm exec vitest run     # 全绿，数量 > 193
pnpm run typecheck
pnpm run lint
pnpm run build
```

跨域手动 smoke（沿用本会话已起的环境）：docker compose 后端（`CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`）+ `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1 pnpm dev`，用 Playwright MCP 在桌面与移动视口跑 I1–I3。

## 完成边界（Definition of Done）

当且仅当以下全部成立，步骤 11 视为完成：

1. 验收标准 A–I 全部满足。
2. H1–H4 四道质量门全绿。
3. send / edit-regen / cancel 三类瞬时失败均弹中文 Toast 并自动消失；run_failed 与标题超时维持原有非 Toast 反馈（未被错误地改造）。
4. 移动端消息操作与侧栏行操作均可经 BottomSheet 触达；桌面端 hover 操作条与 `.history-menu` 下拉回归无变化。
5. 写出交接文档 `docs/handover/frontend/2026-06-10-frontend-toast-and-bottomsheet.md`（含改动、决策、验证结果、Chrome smoke 记录、当前边界）。
6. 工作树干净，按单元逐步提交（TDD：RED → GREEN → commit）。

未达成上述任一条即视为未完成，保持 in_progress 并记录阻塞点。

## 关联文档

- 前序目标：`docs/goals/2026-06-10-frontend-edit-regenerate-and-auto-title.md`
- 前序交接：`docs/handover/frontend/2026-06-10-frontend-edit-regenerate-and-auto-title.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`（交互细节：消息操作 / 认证入口 / Toast / Sheet）
