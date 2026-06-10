# 目标：前端步骤 10 —— 编辑并重发 / 重新生成 / 自动标题 pending

日期：2026-06-10
分支：`refactor/frontend`
承接：`docs/handover/frontend/2026-06-10-frontend-refresh-recovery.md`（步骤 9 已完成）
总计划：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`（实施顺序第 10 步）

## 目标陈述

放开 Message 上现已禁用的「编辑并重发」「重新生成」按钮并接入真实后端，让用户能编辑任一历史 user 消息后重发、或对任一 assistant 回答重新生成；两者都复用步骤 8/9 的 run 生命周期（流式渲染、终态替换、刷新恢复）。同时把状态层已预留但未写入的 `pendingTitleIds` 做实：新对话首个 run 成功后若标题尚未生成，侧栏与顶栏显示骨架占位并轮询，直到真实标题写回或超时回退「新对话」。

完成本步后，重构总计划仅剩步骤 11（Toast / BottomSheet）与步骤 12–13（CI/CD、部署文档、最终 smoke）。

## 范围

### 包含

1. **编辑并重发**（user 消息）：内联编辑 → `conversationApi.editAndRegenerate` → 重拉详情（归档截断后的真实线程）→ 流式新回答。
2. **重新生成**（assistant 消息）：`conversationApi.regenerate` → 重拉详情 → 流式新回答。
3. **变更按钮的 active-run 守卫**：存在 active run 时，两个变更按钮禁用并显示中文原因「请先停止当前生成」；「复制」始终可用。
4. **自动标题 pending**：run 成功后若会话标题为空 → 标记 `pendingTitleIds` + 轮询详情直到标题出现或超时；侧栏行与顶栏在 pending 期间显示 `.title-skeleton`。

### 不包含（明确留给后续）

- Toast / BottomSheet（步骤 11）：本步的编辑/重新生成/标题失败仅 `console` + 不崩溃，不弹中文提示、不做移动端底部操作面板。
- 分支 / 版本树：后端只保留最新版本（归档旧消息），前端不展示历史分支。
- 编辑器状态进 reducer / 跨重渲染持久化：内联编辑器为 Message 局部 state，stream 启动即关闭即可，不要求在任意 rerender 中保留未提交草稿。
- ComposerState 的 reducer 化。

## 已有契约与桩点（不需新建，直接接入）

- 后端端点已存在且有测试（见 `docs/handover/2026-05-19-regenerate.md`）：
  - `POST /conversations/{cid}/messages/{mid}/edit-and-regenerate` body `{content}` → `{message, run}`：归档 mid 及其后所有未归档消息，追加新 user message，queue 新 run。
  - `POST /conversations/{cid}/messages/{mid}/regenerate` → `{message, run}`：assistant 反查其 user 锚点；归档锚点之后所有未归档消息（不动锚点），复用锚点 user_message_id，queue 新 run。
  - 两者遇 active run 返回 **409**（`ensure_no_active_run`，后端不自动 cancel）；跨用户 **404**。
- 前端 API client 已具备：`conversationApi.editAndRegenerate(cid, mid, content)`、`conversationApi.regenerate(cid, mid)`，均返回 `SendMessageResponse {message, run}`。
- 状态层已预留：`ConversationIndexState.pendingTitleIds: number[]`（初值 `[]`，目前无 action 写入）。
- `Topbar` 已支持 `titlePending` 入参并渲染 `.title-skeleton`（AppShell 当前恒传 `false`）。
- `.title-skeleton` 样式已在 `frontend/src/styles/chat.css`。
- `Message` 已有禁用占位按钮（`即将接入`）与图标（`Icons.Pencil` / `Icons.Refresh`）。
- 后端标题生成语义（见 `docs/handover/2026-05-20-...`）：仅在首个 succeeded run 且 `title IS NULL` 时尝试一次，run 成功事务提交后 best-effort，无 SSE title event；前端需主动轮询。
- 旧 vanilla 轮询参数（沿用）：最多 **20** 次、每次间隔 **750ms**（≈15s 窗口）。

## 验收标准

每条均可验证（自动化测试为主，关键路径辅以 Chrome 手动 smoke）。

### A. 编辑并重发（user 消息）

- A1. 非 active-run 下，user 消息的「编辑并重发」可点击；点击进入内联编辑：textarea 预填原文 + 保存/取消。
- A2. 保存（trim 后非空）→ 调 `editAndRegenerate(cid, mid, newContent)`；空内容不触发。取消退出编辑且不调用 API。
- A3. 成功后线程被服务端归档截断后的真实详情替换（被编辑消息及其后旧消息消失，新 user 消息出现在末尾），随后助手新回答以流式气泡渲染，终态由服务端物化消息替换（复用步骤 8 路径）。
- A4. 调用失败（如 409 竞态）不崩溃、不启动流、保留当前视图（中文反馈留步骤 11）。

### B. 重新生成（assistant 消息）

- B1. 非 active-run 下，assistant 消息的「重新生成」可点击 → 调 `regenerate(cid, mid)`。
- B2. 成功后线程替换为归档截断后的详情（旧 assistant 回答消失），新回答流式渲染并在终态被物化消息替换。
- B3. 失败不崩溃、不启动流、保留视图。

### C. active-run 守卫

- C1. 当存在属于当前会话的 active run 时，「编辑并重发」与「重新生成」均 `disabled` 且 `title="请先停止当前生成"`；占位文案「即将接入」被移除。
- C2. active run 期间「复制」仍可用。

### D. 自动标题 pending

- D1. run 成功后重拉详情，若会话 `title` 为空 → 该会话 id 进入 `pendingTitleIds`；侧栏对应行与（若选中）顶栏渲染 `.title-skeleton` 而非「新对话」文本。
- D2. 轮询详情（≤20 次 × 750ms）；标题写回后 → 刷新列表（侧栏显示真实标题）+ 从 `pendingTitleIds` 移除该 id；不再显示骨架。
- D3. 超时（20 次仍为空）或详情请求失败 → 移除 pending，回退显示「新对话」。
- D4. 同一会话不并发重复轮询；退出登录 / 身份失效（`app/reset`）清空 `pendingTitleIds` 并终止轮询副作用（不再 dispatch）。

### E. reducer / 状态

- E1. 新增 `conversations/titlePending {id}`（去重 push）与 `conversations/titleResolved {id}`（filter 移除）；`app/reset` 后 `pendingTitleIds` 为 `[]`。

### F. 质量门（全绿才算完成）

- F1. `pnpm exec vitest run` 全部通过，测试数从 **173** 继续增长（新增覆盖：reducer titlePending/titleResolved、Message 编辑内联 + 两按钮禁用态、编辑/重新生成编排 hook、标题轮询 hook（注入可控计时器/sleep）、Sidebar 骨架行、AppShell 集成编辑→替换 / 重新生成→替换 / active-run 禁用）。
- F2. `pnpm run typecheck` 通过。
- F3. `pnpm run lint` 通过。
- F4. `pnpm run build` 通过。

### G. Chrome 手动 smoke（Playwright MCP，跨域真实后端）

- G1. 编辑历史中部的某条 user 消息 → 其后旧消息消失，新回答流式生成并替换。
- G2. 对某条 assistant 回答点重新生成 → 新回答流式生成并替换。
- G3. 流式中两个变更按钮禁用，hover 显示「请先停止当前生成」。
- G4. 新建对话发首条消息 → 侧栏行先显示骨架,随后在轮询窗口内出现真实自动标题，无「新对话」闪烁回退（标题生成正常时）。

## 预期实现路径（advisory，非强制；保持与现有架构一致）

- **编排**：仿 `useSendMessage(start)` 新增 `useRegenerate(start)`（或合并为一个变更 hook），暴露 `editAndRegenerate(mid, content)` 与 `regenerate(mid)`：调 API → `await conversationApi.detail(cid)` 重拉并 `detailLoaded` → `run/started` → `start(run.id, cid, 0)`。**用 `run` 开流、用重拉详情作为线程事实源；不依赖返回的 `message` 直接渲染**（规避 edit/regen 返回 message 语义差异 + 归档截断）。
- **Message 组件**：新增 props `onEditAndRegenerate(id, content)`、`onRegenerate(id)`、`mutateDisabledReason: string | null`；内联编辑用局部 `useState`。`MessageThread` 透传回调，AppShell 注入。
- **active-run 原因**：AppShell 由 `activeRun?.conversationId === selectedId` 推导 `mutateDisabledReason`（有则「请先停止当前生成」，否则 null）。
- **标题轮询**：在 `useRunStream` 成功路径重拉详情后判断 `title` 为空 → `titlePending` + 触发轮询；轮询逻辑放独立 `useTitlePolling` hook（注入 sleep 便于测试），命中后 `listLoaded` + `titleResolved`，超时/失败 `titleResolved`。Sidebar 接 `pendingTitleIds`，行内 `pendingTitleIds.includes(c.id)` 时渲染骨架；AppShell 给 Topbar 传 `pendingTitleIds.includes(selectedId)`。

## 验证命令

```bash
cd frontend
pnpm exec vitest run     # 全绿，数量 > 173
pnpm run typecheck
pnpm run lint
pnpm run build
```

跨域手动 smoke（沿用本会话已起的环境）：docker compose 后端（`CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`）+ `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1 pnpm dev`，用 Playwright MCP 跑 G1–G4。

## 完成边界（Definition of Done）

当且仅当以下全部成立，步骤 10 视为完成：

1. 验收标准 A–G 全部满足。
2. F1–F4 四道质量门全绿。
3. Message 上不再存在 `即将接入` 占位禁用态；编辑/重新生成走真实 API 与 run 生命周期。
4. `pendingTitleIds` 被真实写入与消费；Topbar 不再恒传 `titlePending={false}`，Sidebar 接入骨架。
5. 写出交接文档 `docs/handover/frontend/2026-06-10-frontend-edit-regenerate-and-auto-title.md`（含改动、决策、验证结果、Chrome smoke 记录、当前边界）。
6. 工作树干净，按单元逐步提交（TDD：RED → GREEN → commit）。

未达成上述任一条即视为未完成，保持 in_progress 并记录阻塞点。
