# 2026-06-10 前端 Toast 失败反馈 / 移动端 BottomSheet 操作面板 交接文档

## 本次完成

实现重构总计划第 11 步（验收边界见 `docs/goals/2026-06-10-frontend-toast-and-bottomsheet.md`）。把步骤 8–10 中「失败仅 `console.error` + 优雅降级」的瞬时操作补上中文 Toast，并为移动端补上消息操作与侧栏行操作的底部操作面板（BottomSheet）：

1. **Toast（瞬时操作失败）**：发送失败 →「发送失败，请重试」；编辑并重发 / 重新生成失败 →「操作失败，请重试」；停止（cancel）请求失败 →「停止失败，请重试」。短暂停留后自动消失，保留原 `console.error`。
2. **Toast 状态层**：`UiState.toast` + `ui/showToast`（单调递增 id，便于同文案重复触发重新动画）/ `ui/hideToast`；`app/reset` 清空。
3. **BottomSheet**：纯展示 `.sheet-backdrop > .sheet`（含 `.sheet-handle`），点 backdrop 关闭、点面板不关闭。
4. **移动端消息操作**：每条消息常驻「更多」→ 底部 sheet 列出 `复制` +（user）`编辑并重发` /（assistant）`重新生成`，遵守 active-run 禁用原因；桌面端维持 hover 操作条不变。
5. **移动端侧栏行操作**：行「更多」→ 底部 sheet 列出 `重命名` / `删除对话`（复用既有就地输入 + ConfirmDialog）；桌面端维持 `.history-menu` 下拉不变。

TDD 逐单元 RED→GREEN→commit，7 个功能提交（`6f21056`..`2915b93`）。前端测试从 **193 增至 216 全绿**（42 个测试文件，新增 2 个：Toast、BottomSheet）。

## 主要改动

### 状态层

- `ui/state.ts`：`UiState` 新增 `toast: {id, message} | null`（初值 `null`）；`uiReducer` 新增 `ui/showToast`（`id = (state.toast?.id ?? 0) + 1`，纯函数推导、无 `Date.now`/随机源）与 `ui/hideToast`；`app/reset` 已统一返回 `initialUiState`，自动清空 toast。

### UI 组件（新增）

- `ui/Toast.tsx`：`{toast, onDismiss, duration=2600}`。`useEffect` 依赖 `toast?.id` 起 `setTimeout(onDismiss)`，cleanup `clearTimeout`——id 变更即清旧计时器重新计时，卸载不再触发 `onDismiss`。`toast==null` 不渲染；否则 `.toast` + `role="status"`。
- `ui/BottomSheet.tsx`：`{open, onClose, children}`。`!open` 返回 null；否则 backdrop `onClick={onClose}` + 面板 `onClick={stopPropagation}` + `.sheet-handle` + children。

### 失败接入（hooks）

- `useSendMessage.ts`：catch 内在 `console.error` 后 `dispatch({type:"ui/showToast", message:"发送失败，请重试"})`。
- `useRegenerate.ts`：catch 内在 `console.error` 后 `dispatch({type:"ui/showToast", message:"操作失败，请重试"})`（编辑并重发与重新生成共用 `run` 编排，一处覆盖两路径）。
- `useRunStream.ts`：cancel 的 catch 内在既有 `run/cancelFailed`（回滚乐观「停止中」）之后追加 `dispatch({type:"ui/showToast", message:"停止失败，请重试"})`。

### 展示组件

- `messages/Message.tsx`：新增 `isMobile?: boolean`。把「复制 + 角色变更操作」抽成共享 `actions(size, afterAction?)`，桌面端渲染进 hover 操作条（`size=12`），移动端渲染进 `BottomSheet`（`size=15` + 选中后关闭 sheet）。移动端每条消息显示常驻「更多」按钮（`aria-label="更多"`），点击 `setSheetOpen(true)`。`mutateDisabledReason` 在两面共用（变更项 `disabled`+`title`，复制始终可用）。内联编辑逻辑（保存/取消/Enter/Esc/空 guard）不变。
- `messages/MessageThread.tsx`：新增 `isMobile?: boolean` 透传给每个 `Message`。
- `conversations/Sidebar.tsx`：把行的「重命名 / 删除对话」两按钮抽成共享 `rowActions(itemStyle?)`。桌面端（`!isMobile`）渲染进既有 `.history-menu` 锚定下拉；移动端渲染进 `BottomSheet`（`menuOpen=menuFor===c.id` 驱动）。引入 `type CSSProperties`。

### 装配

- `app/AppShell.tsx`：`useCallback` 包 `dismissToast = () => dispatch({type:"ui/hideToast"})`（稳定引用，避免 Toast 自动消失 effect 每次 render 重新计时）；末尾渲染 `<Toast toast={ui.toast} onDismiss={dismissToast} />`；`MessageThread` 接 `isMobile={isMobile}`（`isMobile` 由既有 `useIsMobile()<760` 提供）。

### 样式

- `styles/chat.css`：追加 `.sheet-backdrop` / `.sheet` / `.sheet-handle` / `@keyframes sheet-in` / `.toast` / `@keyframes toast-in`（移植自 `uiux_v1.html`）。`.sheet-item` 早已存在（侧栏下拉用），sheet 复用。toast 用既有 `--radius` token。

## 关键文件

- `frontend/src/ui/Toast.tsx`：自动消失计时挂在 `toast.id` 依赖上——id 即「重放」键，是同文案重复弹出能重新动画与重新计时的关键。
- `frontend/src/ui/BottomSheet.tsx`：移动端两处操作面板（消息 / 侧栏行）的共用容器。
- `frontend/src/messages/Message.tsx`：`actions()` 共享 + `isMobile` 分流，是「桌面 hover 条 / 移动 sheet 同一组操作」的单一事实源。
- `frontend/src/conversations/Sidebar.tsx`：`rowActions()` 共享 + `isMobile` 分流（桌面下拉 / 移动 sheet）。

## 设计决策

### Toast 接入点：仅瞬时操作失败

经确认，Toast 只接 send / edit-regen / cancel 三类**瞬时操作**失败。两类**非瞬时**反馈维持原状、未被改造：

- `run_failed` / `run_cancelled`：维持步骤 8 的**气泡内状态条**（`生成失败 · 请稍后重试` / `已停止`），不另弹 Toast——它们是流的终态展示，不是一次性操作反馈。
- 自动标题轮询超时 / 详情失败：维持步骤 10 的**静默回退「新对话」**——标题滞后本身就是优雅降级，弹 Toast 反而打扰。

### toast id 在 reducer 内单调推导

`showToast` 用 `(state.toast?.id ?? 0) + 1` 生成 id，而非 `Date.now()`/随机源，保持 reducer 纯函数、计时器只在组件层（与项目既有约定一致）。组件以 `toast.id` 作为 effect 依赖，因此「同一文案连续两次失败」也会换 id → 重新计时 + 重放入场动画。

### 移动端操作面板复用桌面动作，不另写一套

`Message` 与 `Sidebar` 都把动作按钮抽成一个内部渲染函数，桌面与移动只是**容器不同**（hover 条 / 下拉 vs BottomSheet），动作 onClick、禁用原因、图标完全共享。避免「移动端逻辑漂移」，也使 `mutateDisabledReason` 等守卫天然在两面一致。

### isMobile 由 AppShell 既有断点驱动

不引入新的 `matchMedia` 监听，直接复用 `useIsMobile()`（`<760`，已用于 Sidebar 抽屉），透传到 MessageThread→Message。桌面端 `isMobile=false` 时**完全不渲染**「更多」按钮与 sheet，桌面回归零变化。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 216 个测试全部通过（42 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过
```

测试矩阵（本次新增 23 个）：reducer showToast 单调 id / hideToast / reset 清空；Toast 渲染 + role=status / 自动消失 / 卸载不触发 / id 变更重新计时；BottomSheet 关闭不渲染 / 打开渲染面板+handle / backdrop 关闭 / 内容不关闭；useSendMessage 失败弹「发送失败」；useRegenerate 失败弹「操作失败」；useRunStream cancel 失败弹「停止失败」；Message 桌面无「更多」/ 移动 user sheet（复制+编辑并重发）/ 移动复制 / 移动 assistant 重新生成 / 移动禁用态+title；MessageThread 透传 isMobile；Sidebar 移动行 sheet（含 `.sheet` 存在 + 无 `.history-menu`）/ 移动重命名就地编辑；AppShell 发送失败弹 toast。

### Chrome 手动 smoke（Playwright MCP，跨域真实 DeepSeek）

- **I1 桌面 Toast** ✅：流式中点「停止生成」，用路由拦截令 `POST /runs/{id}/cancel` 失败 → 底部出现 `.toast[role=status]`「停止失败，请重试」，composer 同时进入「正在停止…」，2.6s 后自动消失；桌面消息 hover 操作条与侧栏下拉无变化。
- **I2 移动消息 sheet** ✅（390×780）：每条消息只显「更多」；user 消息 sheet = `["复制","编辑并重发"]`，assistant 消息 sheet = `["复制","重新生成"]`；backdrop 轻触关闭；sheet 底部对齐 + 拖拽 handle 可见。
- **I3 移动侧栏行 sheet** ✅：行「更多」打开 sheet = `["重命名","删除对话"]`，且**无** `.history-menu` 下拉；「删除对话」→ 打开 ConfirmDialog（标题「删除对话？」），「取消」关闭且对话仍在列表（未误删）。

> 实现注记：jsdom 测试不受 `:hover` 影响可直接断言移动「更多」与 sheet 内按钮；浏览器中桌面操作条仍靠 `.msg:hover` 显形。smoke 中需先点 `.scrim` 关闭历史抽屉再操作消息 sheet（抽屉 scrim 会拦截指针事件）。

## 当前边界

已完成（含前序）：发送 / 流式 / 停止 / 失败 / 刷新恢复 / 跨会话防泄漏 / 编辑并重发 / 重新生成 / active-run 守卫 / 自动标题 pending / **瞬时失败 Toast** / **移动端消息与侧栏 BottomSheet**。

未完成，留给后续：

- **步骤 12–13**：CI/CD 拆分（前端 `pnpm lint/typecheck/test/build`、后端 ruff/mypy/pytest/docker）、部署文档（Cloudflare Pages 前端 + `api.feslia.com` 后端）、Nginx/Cloudflare 子域与 SSE 配置说明、最终桌面 / 移动 smoke。

## 注意事项

- Toast 自动消失依赖 `toast.id` 作为 effect 依赖；勿改用 `message` 作 key——同文案重复失败将不再重新计时/动画。`onDismiss` 必须用 `useCallback` 稳定，否则每次 render 都重置计时器、toast 永不消失。
- `run_failed` 与标题超时**有意不弹 Toast**；若后续要改，先回看本步「Toast 接入点」决策与 goals 的范围约定，避免与气泡状态条 / 静默回退重复。
- 移动端「更多」与 sheet 仅在 `isMobile`（`<760`）渲染；桌面端零新增 DOM。Message/Sidebar 的动作是共享渲染函数，改动作记得两面一致。
- smoke 用路由拦截制造失败（`route.abort`）：拦 cancel 用独立常驻 handler 比「拦一次即 unroute」稳（后者易与 React 异步发起竞态）。

## 关联文档

- 验收边界：`docs/goals/2026-06-10-frontend-toast-and-bottomsheet.md`
- 前序交接：`docs/handover/frontend/2026-06-10-frontend-edit-regenerate-and-auto-title.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`（交互细节：消息操作 / 认证入口 / Toast / Sheet）
