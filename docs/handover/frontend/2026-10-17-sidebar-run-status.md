# 侧栏会话运行状态与提交即生成标题

日期：2026-10-17 · 分支：`feat/sidebar-run-status` · 设计提案：`sidebar-run-status`（已提升为 current，审批见 `design/approvals/2026-10-17-sidebar-run-status.json`）

## 背景

1. 新会话发送后，侧栏要等首个 Run 成功、详情与索引重拉后才出现；标题再晚一步出现。
2. 标题基于「用户首条消息 + 助手首条回复」生成，必须等完整回复结束。ChatGPT / Claude 均在用户发送后立即生成标题。
3. 用户可在多个会话并发发起 Run，但侧栏没有任何「进行中」或「后台已完成」的提示。

## 后端变更

- **提交即激活**：`service.py` 在接受用户消息时设置 `activated_at`（若为空）并刷新 `updated_at`，会话立即进入侧栏列表。创建事务里 `now()` 与插入值相同，因此用 `flag_modified` 强制写入，避免 onupdate 使响应中的 `updated_at` 过期。
- **提交即生成标题**：4 个提交路由（新建并发送、发送、编辑、重新生成）在事务提交后调用 `create_title_job`，再经 `title_publisher.py` 的 `CeleryTitleTaskPublisher` 投递。投递失败只记日志，由既有标题 sweep 兜底。
  - `create_title_job` 不再要求 Run 成功、也不再要求「首个成功 Run」；每个会话最多一个标题任务，`title` 非空时为 no-op。
  - `llm_tasks.py` / `title_agent.py` 仅使用用户消息与附件元数据生成标题，不再读取助手回复。
  - `worker/executor.py` 移除 Run 成功后的标题投递，worker 不再参与标题。
- **列表携带 active Run**：`GET /conversations` 返回 `ConversationListItemResponse`，新增 `active_run: {id, status} | null`，取自 `ACTIVE_RUN_STATUSES` 的 Run（一次批量查询）。详情接口不变。
- 注意：标题任务写入会推进 `conversation.updated_at`；Run 结束不推进。

## 前端变更

### 状态（`conversations/state.ts`）

- `conversationIndex.unreadIds: string[]`：后台完成且尚未查看的会话。
- `conversations/runStarted {conversation, run, updatedAt}`：把会话置顶、写入 `active_run` 与 `updated_at`；无标题时加入 `pendingTitleIds`。新会话在 `draftCreated` 后、已有会话在发送成功后派发。
- `conversations/runFinished {id}`：清除 `active_run`；若该会话不是当前选中会话则标记未读。`useRunStream` 在任何终态（成功/失败/取消）后派发。
- `conversations/listSynced {items}`：轮询与成功后重拉第一页都走它。与 `listLoaded` 共用 `reconcileList`：
  - 原有 `active_run` 消失且未选中 → 标记未读；
  - pending 标题已有值 → 移出 pending；
  - `mergeFirstPage`：服务端行的 `updated_at` 旧于本地时保留本地行（避免覆盖刚 `runStarted` 的乐观状态），并保留第一页之外已加载的行，不改 `hasMore`。
- `selected` 与 `removed` 会从 `unreadIds` 中移除对应 id；`renamed` 保留 `active_run`。
- 详情 reducer 在 `listLoaded` / `listSynced` 时，若同步行 `updated_at >= 当前详情`，同步 `conversation.title`。

### 轮询（`conversations/useConversationListSync.ts`，替代已删除的 `useTitlePolling`）

- 存在 pending 标题：每 1s 拉第一页；每个标题 20s 超时后放弃（`titleResolved`，显示回落文案）。
- 否则若有会话的 `active_run` 不是本地正在消费的 Run（即后台 Run 或其他标签页发起的 Run）：每 3s 拉一次。
- 两者都没有：不轮询。带 in-flight 保护；登出后丢弃结果。

### UI

- `AppShell` 汇总 `rowStatus`：未读 → `unread`；有 `active_run`、本地 activeRun 处于 queued/started/streaming/cancelling、或 `pendingSubmission` 指向该会话 → `running`（未读优先）。
- `Sidebar` 行尾：`running` 显示旋转图标（一圈 1.5s，慢于默认 `animate-spin` 的 1s；2026-10-24 在 design 中用转速滑块选定），`unread` 显示 `--color-unread-indicator`（#1a73c7）圆点；悬停/聚焦时让位给「更多」按钮。无标题时显示骨架占位。行高在所有阶段保持不变（桌面 36px，移动端 44px），符合 AGENTS.md 流式表面几何约束。
- 收起侧栏的「最近聊天」按钮与移动端「打开历史」按钮在存在未读时显示角标，无障碍名称追加「，有新回复」。

## 验证

- 后端：`tests/api/test_conversations.py`、`tests/tasks/test_llm_tasks.py`、`tests/services/agents/test_title_agent.py`、`tests/worker/test_executor.py`。
- 前端：lint、typecheck、vitest（84 文件 / 792 用例）、build 全部通过；新增 `useConversationListSync.test.tsx` 与 state / Sidebar / useSendMessage / useRunStream 用例。
- design：catalog、lint、typecheck、test、check:boundaries、parity（56）与 visual（124）通过。
- 真实 Chrome（临时 Postgres + Redis、本地测试用户）：
  - 发送后约 0.48s（API 返回后）出现占位行（骨架 + 旋转图标）；
  - 无 Celery worker 时 20s 后标题回落为「新对话」；
  - 查看 B 时把 A 的 Run 在数据库中置为 succeeded，3s 轮询内 A 出现蓝点，进入 A 后清除；
  - 各阶段行高恒为 36px（桌面）/ 44px（移动端）；移动端「打开历史，有新回复」角标出现。

## 已知限制与取舍

- 占位行在提交 API 返回后才出现（约 0.5s），不是点击发送时的纯乐观插入。
- 未读状态只保存在内存；刷新页面后，期间完成的后台 Run 不会显示未读。
- 后台 Run 完成依赖 3s 轮询；当前流仅在登出或新的 `start()`（如进入另一个运行中的会话触发恢复）时中止，因此离开会话后本地流通常仍会派发 `runFinished`。
- 本变更取代 `docs/handover/2026-05-20-auto-title-and-draft-conversation.md` 与 `docs/handover/frontend/2026-06-10-frontend-edit-regenerate-and-auto-title.md` 中「首个 Run 成功后基于问答对生成标题」「首个 Run 成功后才激活会话」的描述。
