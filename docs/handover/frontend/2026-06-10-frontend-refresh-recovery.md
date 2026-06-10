# 2026-06-10 前端刷新恢复与取消健壮化交接文档

## 本次完成

实现重构总计划第 9 步：**进行中 run 的刷新恢复 + partial 跨导航恢复 + cancel 最小健壮化**。本轮按用户要求未走 spec → plan 流程，直接基于总设计（`2026-05-24-frontend-react-rebuild-design.md` 的「刷新恢复」节）与既有代码实现，仍保持 TDD 与逐单元提交（`3fd6ec7`..`13e9eae`，5 个提交）。前端测试从 151 增至 **171 全绿**（38 个测试文件）。

核心语义：**进入会话（刷新恢复 / 侧栏选择 / 删除回退自动选中）= 尝试挂接该会话的 pending run**。线程末尾的 user message 带 `run_id` 且没有同 run 的物化 assistant 消息时，调 `runApi.state(runId)`：

- run 仍在进行（queued/started/streaming/cancelling）→ 用 `draft_text` / `draft_reasoning` / `latest_seq` 恢复流式气泡，并以 `after_seq=latest_seq` 续流——不从头重放、不重复内容。
- run 已失败 / 已取消 → 恢复 partial 正文 / 思考 + 对应 `.status-pill`（「已停止」/「生成失败 · 请稍后重试」），不开流。**刷新或切走后 partial 不再丢失**（数据源是服务端持久化的 draft）。
- run 已成功（detail 快照早于物化的竞态）→ 重拉 detail + list，直接显示真实回复。

取消健壮化（最小版）：cancel 请求失败时派发 `run/cancelFailed`，把乐观的「停止中」回退为 streaming，停止按钮恢复可点、用户可重试；中文错误反馈仍留给步骤 11 的 Toast。

## 主要改动

### `src/runs/state.ts` — 新增 2 个 action

- `run/restored` `{runId, conversationId, latestSeq, draftText, draftReasoning, status}`：从服务端 run state 整体重建 activeRun；`status === "cancelling"` 时 `cancelRequested: true`（刷新时恰处取消中 → 按钮恢复为「停止中」并等终态）。
- `run/cancelFailed`：仅当 `status === "cancelling"` 时回退为 `{status: "streaming", cancelRequested: false}`；state 为 null 或已是终态（竞态先到）时 no-op。

### `src/runs/pendingRun.ts`（新增）

`findPendingRunId(messages)` 纯函数：从尾部找最后一个带 `run_id` 的 user message，线程中无同 run 的 assistant 物化消息则返回该 `run_id`，否则 null。

### `src/runs/useRunStream.ts` — 两处增强

- `start` 持有 `controllerRef`，启动新流前先 abort 上一条——发送或恢复重新挂接时，后台可能仍在读的旧流被掐断，事件不会被消费两次（此前切走会话后旧流继续后台读，依赖 activeRun null no-op 兜底；现在重新挂接也安全）。
- `cancel` 的 catch 从静默吞掉改为派发 `run/cancelFailed`。

### `src/runs/useRunRecovery.ts`（新增）

`useRunRecovery(start)` 返回 `recover(conversationId)`，编排上文核心语义。防御：detail 不属于该会话 / activeRun 已挂接该会话（重复点击当前会话）→ 跳过；`runApi.state` 失败 → 静默放弃（best-effort，会话按纯历史展示）；state 调用期间用户切走（`stateRef` 校验）→ 不应用。`start` 由 AppShell 注入，与 `useSendMessage` 同模式。

### `src/app/AppShell.tsx` — 三个入口接线

- bootstrap：恢复存储选择后 `await recover(storedId)`。
- `onSelectConversation`：`selectConversation(id).then(() => recover(id))`。
- 删除确认后：若删除导致自动选中下一个会话，对其同样 `recover`（读 `stateRef` 拿最新 selectedId）。

## 数据流

### 刷新恢复（进行中）

启动 → loadList → selectConversation(stored) → detail 回填 → `recover`：findPendingRunId 命中 → `runApi.state` → `run/restored`（流式气泡带已生成内容出现，Composer 转 streaming）→ `start(runId, convId, latest_seq)` 续流 → 增量继续 → 终态走既有 useRunStream 路径（成功重拉替换 / 失败保留）。

### 切走再切回（流式中）

切走：`run/cleared`（UI 丢弃流式态），旧流后台继续（deltas no-op，成功仍会刷新列表）。切回：`recover` → state 给出最新 cursor → `run/restored` + `start` 续流，`start` 先 abort 旧流 → 无重复消费。若期间 run 已成功 → findPendingRunId 不命中（detail 重拉已含回复）或 state 返回 succeeded → 重拉，均显示真实回复。

### 停止失败重试

停止 → 「停止中」→ cancel 请求失败 → `run/cancelFailed` → 按钮回「停止生成」可重试；若失败与服务端终态竞态，终态优先（reducer 只在 cancelling 时回退）。

## 计划外修复

**`e66d9b4`** Chrome smoke 发现步骤 8 遗留 bug：点击停止并收到 `run_cancelled` 终态后，Composer 永远卡在禁用的「停止中」按钮——`composerState` 推导先检查 `cancelRequested`，而该标志在终态后仍为 true，终态分支永远走不到 idle。修复为仅由 `status` 推导（`cancelling` 是唯一 stopping 态），并补了一个走完整「点停止 → 服务端终态」序列的集成测试（用可控的挂起流模拟真实时序）。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 172 个测试全部通过（38 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过
```

测试矩阵（本次新增 20 个）：activeRunReducer（restored 全字段 / cancelling 置 cancelRequested / cancelFailed 回退 / 非 cancelling no-op）、findPendingRunId（空线程 / pending / 已物化 / 多轮取末轮 / 无 run_id）、useRunStream（cancel 失败回退 streaming / 新 start abort 旧流）、useRunRecovery（无 pending 不调 state / 进行中恢复+续流游标 / 终态恢复不开流 / succeeded 重拉 / state 失败静默 / 已挂接跳过 / detail 不匹配跳过）、AppShell 集成（刷新后恢复已停止 partial + pill 且不开流 / 刷新后从 latest_seq 续流并被服务端回复替换）。

既有用例适配 1 处：AppShell「选择加载详情」的 detail fixture 补了物化 assistant 消息（接入恢复后，原 fixture 的孤立 user message 会真实触发恢复，导致文案重复匹配——这正是恢复逻辑在工作）。

**已做本地跨域 Chrome smoke**（真实 DeepSeek、CDP 驱动真实 Chrome，docker compose 后端 + Vite dev 前端跨域）：

- 流式中刷新：刷新前 1103 字符 → 恢复 1262 字符并续流增长，开头文本仅出现一次（不重不丢）；终态后物化替换，仅 1 条助手消息，草稿激活进侧栏，自动标题正常。
- 停止 → 刷新：「停止中」→「已停止」pill；刷新后 192 字符 partial 原样恢复 + pill，无续流，Composer 可用。
- 流式中切走再切回：切走后空白态无流式泄漏；切回时从服务端 cursor 恢复（65 → 1044 字符）并继续流式，终态物化正常。
- 期间发现并修复 Composer 停止后卡死 bug（见「计划外修复」）。

## 当前边界

已完成（含前序）：发送 / 流式 / 停止 / 失败 / 刷新恢复 / partial 跨导航与刷新恢复 / cancel 失败重试。

未完成，留给后续：

- **步骤 10**：编辑并重新生成、重新生成回答（Message 按钮仍禁用）；自动标题 pending 骨架与轮询（`pendingTitleIds` 仍无写入）。
- **步骤 11**：Toast / BottomSheet（cancel 失败、发送失败的中文提示挂这里）。
- **步骤 12–13**：CI/CD、部署文档、最终桌面 / 移动 smoke。
- 草稿会话 id（`draftId`）未持久化到 localStorage：刷新后草稿会话仍可经 `selectedConversationId` 恢复并续流，只是 `draftId` 状态位丢失；当前无可见影响（draftActivated 对 null 是 no-op），若步骤 10 的标题逻辑依赖它再补。

## 注意事项

- `recover` 是幂等、best-effort 的：任何失败都让会话按纯历史展示，不抛错、不打断导航。
- `start` 现在会 abort 上一条流——如果将来出现「并行多 run」需求，这个单流假设要先拆掉。
- 恢复的 activeRun 与发送产生的 activeRun 走完全相同的渲染与终态路径（StreamingMessage / Composer 三态 / useRunStream 终态处理），不要为恢复单加 UI 分支。
- 后端 `GET /runs/{id}/state` 返回 `draft_reasoning`（2026-05-21 thinking 设计起），恢复的思考区为折叠的「已思考」态（`streaming` 仅在无正文时为 true）。

## 关联文档

- 前序交接：`docs/handover/frontend/2026-06-09-frontend-send-and-sse-streaming.md`
- 重构总设计（刷新恢复节）：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
- 后端 run state / SSE replay：`docs/handover/2026-05-17-run-events-sse-replay.md`
