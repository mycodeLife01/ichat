# 2026-06-10 前端编辑并重发 / 重新生成 / 自动标题 pending 交接文档

## 本次完成

实现重构总计划第 10 步（验收边界见 `docs/goals/2026-06-10-frontend-edit-regenerate-and-auto-title.md`）。在步骤 8/9 的 run 生命周期之上放开两类消息变更操作，并把状态层预留的 `pendingTitleIds` 做实：

1. **编辑并重发**（user 消息）：内联编辑 → `editAndRegenerate` → 重拉归档截断后的详情 → 流式新回答。
2. **重新生成**（assistant 消息）：`regenerate` → 重拉详情 → 流式新回答。
3. **active-run 守卫**：当前会话有 active run 时两个变更按钮禁用并提示「请先停止当前生成」，「复制」始终可用。
4. **自动标题 pending**：run 成功后若标题为空 → `titlePending` + 轮询（≤20 次 × 750ms）直到标题写回（刷新侧栏）或超时回退「新对话」；pending 期间侧栏行与顶栏显示 `.title-skeleton`。

TDD 逐单元 RED→GREEN→commit，7 个功能提交（`ed47a21`..`0915e51`）。前端测试从 **173 增至 193 全绿**（40 个测试文件）。

## 主要改动

### 状态层

- `conversations/state.ts`：`ConversationIndexAction` 新增 `conversations/titlePending {id}`（去重 push）与 `conversations/titleResolved {id}`（filter 移除）；`app/reset` 清空 `pendingTitleIds`。

### 编排（hooks）

- `conversations/useRegenerate.ts`（新增）：`useRegenerate(start)` → `{editAndRegenerate(mid, content), regenerate(mid)}`。两者调对应 API 后 **重拉 detail 作为归档截断后的线程事实源**（不依赖返回的 `message` 直接渲染，规避 edit/regen 返回 message 语义差异），再 `run/started` + `start` 复用既有流式路径。空内容 / 无选中 guard；失败仅 `console` + 保留视图（中文反馈留步骤 11）。
- `conversations/useTitlePolling.ts`（新增）：`poll(cid, {attempts=20, delayMs=750, sleep})`。以 **running ref** 去重（非 pendingTitleIds，避免「已 pending 即不轮询」的死锁）；标题写回 → `listLoaded` + `titleResolved`；详情失败 / 超时 → `titleResolved`；循环内检测 `pendingTitleIds` 被 `app/reset` 清空则静默终止。`sleep` 可注入便于测试。
- `runs/useRunStream.ts`：成功路径重拉 detail 后，`if (!detail.title?.trim())` → dispatch `titlePending`（仅派发，轮询由 AppShell effect 驱动）。

### 展示组件

- `messages/Message.tsx`：移除 `即将接入` 占位。新增 props `mutateDisabledReason`、`onEditAndRegenerate`、`onRegenerate`。user 消息「编辑并重发」进入内联 `.edit-box` 编辑（textarea 预填 + 保存/取消，Enter 保存、Esc 取消、空内容禁用保存）；assistant 消息「重新生成」直接触发。`mutateDisabledReason` 非空时两按钮 `disabled` 且 `title=该原因`。
- `messages/MessageThread.tsx`：透传 `mutateDisabledReason` / `onEditAndRegenerate` / `onRegenerate` 给每个 `Message`。
- `conversations/Sidebar.tsx`：新增 `pendingTitleIds` prop；行 id 命中时渲染 `.title-skeleton`（与 Topbar 一致），否则 `c.title || "新对话"`。

### 装配

- `app/AppShell.tsx`：实例化 `useRegenerate(start)` 与 `useTitlePolling`；派生 `mutateDisabledReason`（`activeRun?.conversationId === selectedId` 时为「请先停止当前生成」）；新增 effect 监听 `pendingTitleIds` 为每个 id 调 `pollTitle`（running ref 去重）；Sidebar 接 `pendingTitleIds`，Topbar `titlePending={selectedId 在 pendingTitleIds 中}`，MessageThread 接变更回调。

## 关键文件

- `frontend/src/conversations/useRegenerate.ts`：编辑/重新生成的唯一编排入口；「重拉详情而非信任返回 message」是关键决策。
- `frontend/src/conversations/useTitlePolling.ts`：running-ref 去重 + 可注入 sleep；与 useRunStream 的「只 dispatch titlePending」+ AppShell 的「effect 驱动轮询」三者配合。
- `frontend/src/app/AppShell.tsx`：变更回调、禁用原因、标题轮询 effect 的装配点。

## 设计决策

### 重拉详情作为截断后事实源

edit/regen 后端会归档锚点之后（或之处）的所有消息并 queue 新 run。前端不做客户端截断（position/archived_at 易错），而是 `await conversationApi.detail(cid)` 取权威的截断后线程，再开流——与 run 成功的「重拉替换」语义一致，复用 StreamingMessage / 终态路径，无需新分支。

### 标题轮询的三段式拆分

「决定显示骨架」（useRunStream 同步 dispatch titlePending）与「轮询直到写回」（AppShell effect → useTitlePolling 循环）分离：前者易测且无计时器，后者用 running-ref 去重使「id 已 pending」不会阻止轮询启动。useTitlePolling 早期版本以 `pendingTitleIds.includes` 去重会与该拆分冲突（effect 调用即被自身已派发的 pending 挡掉），改 running-ref 修复。

### mutate 守卫由 status 推导

`mutateDisabledReason` 仅在 `activeRun.conversationId === selectedId` 时为非空，复用与 Composer 三态一致的判定，后端的 409 active-run 守卫是兜底。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 193 个测试全部通过（40 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过
```

测试矩阵（本次新增 20 个）：reducer titlePending/titleResolved 去重与 reset 清空、Message 内联编辑提交/取消/空 guard/重新生成/禁用态+title/复制可用、useRegenerate edit+regen 全链路/空内容/无选中/失败保留、useTitlePolling pending 标记/超时清理/命中刷新列表/详情失败清理/单 poller 去重、useRunStream 空标题→titlePending 与有标题→不 pending、Sidebar 骨架行、AppShell 集成（编辑→截断+流式替换 / 重新生成→替换 / 流式中禁用变更按钮）。

### Chrome 手动 smoke（Playwright MCP，跨域真实 DeepSeek）

- **G1 编辑并重发** ✅：编辑中部 user 消息「火山」→「请用一句话说明什么是黑洞」，其后旧答案 + 更晚的「灯塔」整轮被归档消失，新答案「黑洞是时空中…」流式生成并替换。
- **G2 重新生成** ✅：对末条 assistant 点重新生成，user 锚点保持唯一（不重复），新答案「黑洞是一种引力极强…连光都无法从中逃脱」与上一版措辞不同。
- **G3 流式禁用** ✅：发长消息流式中，全部 7 个变更按钮 `disabled` 且 `title=请先停止当前生成`，「复制」仍可用。
- **G4 自动标题** ✅（终态）：新建对话发首条 → 侧栏出现真实自动标题「光合作用基本原理」「熵的定义」，无「新对话」闪烁回退。

> G4 注记：实测 DeepSeek summary 生成标题足够快，**run 成功后前端重拉 detail 时标题已写回**，因此未进入 `titlePending` 分支、骨架未在浏览器中出现——这是期望结果（骨架是标题生成滞后时的优雅回退）。骨架渲染本身由 Sidebar 单测（pending id 渲染 `.title-skeleton`）与 useRunStream 单测（空标题→titlePending）覆盖。

## 当前边界

已完成（含前序）：发送 / 流式 / 停止 / 失败 / 刷新恢复 / 跨会话防泄漏 / 编辑并重发 / 重新生成 / active-run 守卫 / 自动标题 pending。

未完成，留给后续：

- **步骤 11**：Toast / BottomSheet（demo 的 `.sheet-*` / `.toast` 未移植）。本步 edit/regen/cancel 失败、标题超时仅 console + 优雅降级，中文 toast 反馈挂这里；移动端消息操作底部面板亦在此步。
- **步骤 12–13**：CI/CD 拆分、部署文档、Nginx/Cloudflare 配置、最终桌面 / 移动 smoke。

## 注意事项

- `useTitlePolling` 用 **running ref** 去重，勿改回 `pendingTitleIds.includes`——会与 useRunStream 先派发 titlePending 的拆分冲突导致永不轮询。
- edit/regen 依赖「重拉 detail」，因此 fake/真实后端必须在调用后返回截断后的 detail；集成测试用 `mockResolvedValueOnce` 链模拟初始/截断/成功三次 detail。
- 标题骨架在快后端下基本不出现属正常；若要可视化验证骨架，需人为延迟 summary 生成或在 pendingTitleIds 注入 id。
- 变更按钮在 `.msg:hover` 时显形（CSS），jsdom/测试中不受 hover 影响可直接断言。

## 关联文档

- 验收边界：`docs/goals/2026-06-10-frontend-edit-regenerate-and-auto-title.md`
- 前序交接：`docs/handover/frontend/2026-06-10-frontend-refresh-recovery.md`
- 后端 regenerate：`docs/handover/2026-05-19-regenerate.md`
- 后端草稿与自动标题：`docs/handover/2026-05-20-auto-title-and-draft-conversation.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
