# 前端发送消息与 SSE 基础流式设计

日期：2026-06-09

## 目标

承接 `2026-06-08-frontend-conversation-list-and-detail-design.md`（已实现：会话列表 + 只读详情 + 会话管理）。本设计落地前端重构总计划（`2026-05-24-frontend-react-rebuild-design.md`）第 8 步：**发送消息 + SSE 基础流式**。

用户在选中会话或空白（草稿）态下输入并发送 → 立即显示用户消息 → 实时流式渲染助手的思考过程与正文 → run 成功后用服务端物化的真实助手消息替换流式气泡，并刷新侧栏列表。失败 / 取消按最小处理（停流、保留 partial、状态文字、恢复输入），不做重试与重连。

这是整个剩余重构工作（停止生成、刷新恢复、编辑 / 重新生成、自动标题）的基石：run 生命周期的状态转移、`useRunStream` 流式消费、Composer 发送链路在本轮全部打通并被测试覆盖，后续步骤在其上扩展。

## 背景与现状

通信底座（总计划第 2 步）已完整且有测试：
- `runApi.streamEvents(runId, afterSeq, {signal})`：`fetch` + `ReadableStream` 的 SSE 异步生成器，已识别 terminal event 后自动结束。
- `runApi.state(runId)` / `runApi.cancel(runId)`。
- `conversationApi.create() / detail() / list() / sendMessage() / editAndRegenerate() / regenerate()`。
- `sse.ts` 的 `SseParser` / `decodeSseStream`。

状态脚手架已类型化并打桩，待本轮做实：
- `runs/state.ts`：`ActiveRunState` 形状已定，`activeRunReducer` 仅处理 `app/reset`。
- `runs/useRunStream.ts`：占位，调用即抛异常。
- `ConversationIndexState.draftId` / `pendingTitleIds` 字段已保留但无 action 写入。
- `ui/Composer.tsx`：发送按钮 `disabled`，`onKeyDown` 已拦截 Enter 但不提交（键盘 / IME 结构预留）。
- `messages/ThinkingBlock.tsx`：`streaming` 入参已预留。

### 已确认的后端契约

- SSE event data 形如 `{"seq":2,"type":"text_delta","payload":{"text":"Hello"},"created_at":"..."}`。`text_delta` 与 `reasoning_delta` 的增量均在 `payload.text`。前端 `RunStreamEvent.data.payload.text` 取值。
- terminal event 类型：`run_succeeded` / `run_failed` / `run_cancelled`。`run_started` 仅作起始标记。
- `conversationApi.sendMessage(id, content)` 返回 `{message: MessageResponse, run: RunResponse}`——服务端已物化的真实 user message 立即可用，因此只有助手侧需要流式占位。
- 草稿语义：`POST /conversations` 返回 `activated_at: null`，且草稿**不**出现在 `GET /conversations`（列表过滤 `activated_at IS NOT NULL`）；`GET /conversations/{id}` 不过滤草稿；worker 在首个 run 成功时激活会话。因此「无选中 → 发送」= 建草稿 → 发送 → 成功后重拉 detail + list（草稿激活后才进列表）。
- 失败 / 取消的 run 不物化 assistant message、不激活会话。

## 已确认决策

| 决策点 | 选择 |
|--------|------|
| 失败终态处理深度 | 最小处理：停流、保留 partial 正文 / 思考、显示状态文字、恢复输入；不重试、不重连 |
| 流式助手内容的渲染方式 | 方案 A：`conversationDetail.messages` 保持服务端事实源；流式内容由独立的 `activeRun` 切片驱动、渲染为挂在消息列表之后的临时气泡；成功后重拉 detail 替换 |
| 自动滚动 | 纳入本轮，最小 near-bottom 跟随（用户上滚阅读时不打断） |
| ComposerState reducer 化 | 本轮不做，`composer.input` 留在 AppShell 局部 state；随步骤 9 的发送 / 停止 sendability 一起做 |

### 为什么选方案 A（而非合成占位 / 折叠进 detail 切片）

- **方案 A（采用）**：`messages` 纯服务端事实源；`activeRun` 切片独立持有流式草稿；`StreamingMessage` 临时气泡渲染。匹配总计划状态模型表（ActiveRun 自成一层），成功路径是干净的「重拉替换」，`useRunStream` 保持可序列化（AbortController 只在 ref）。
- 方案 B（合成占位塞进 `messages`）：污染服务端事实源、需要合成 id 在终态时对账、reducer 每个 delta 重写消息数组项，重渲染面更大。否决。
- 方案 C（把草稿字段折叠进 `conversationDetail`）：丢弃已类型化的 `activeRun` 切片与 `useRunStream` 契约，并把「当前详情」与「run 生命周期」混为一谈——而后者正是步骤 9（取消、刷新恢复）需要独立拥有的关注点。违背总设计。否决。

## 状态层改动

### `runs/state.ts` — 做实 `activeRunReducer`

`ActiveRunState` 形状不变（AbortController 仍不入 reducer）。新增 action：

| action | 转移 |
|--------|------|
| `run/started` `{runId, conversationId}` | 整体置初值：`status:"started"`、`latestSeq:0`、`draftText:""`、`draftReasoning:""`、`cancelRequested:false`（覆盖任何旧 activeRun） |
| `run/reasoningDelta` `{seq, text}` | `draftReasoning += text`，`latestSeq=seq`，`status:"streaming"` |
| `run/textDelta` `{seq, text}` | `draftText += text`，`latestSeq=seq`，`status:"streaming"` |
| `run/terminal` `{status}` | 设 `status` 为 `succeeded` / `failed` / `cancelled`，**保留** drafts |
| `run/cleared` | → `null` |
| `app/reset` | → `null`（已有） |

`run/reasoningDelta` / `run/textDelta` / `run/terminal` 在 `state === null` 时为 no-op（防御性：用户已切走会话清空了 activeRun，但 in-flight 事件仍在到达）。

### `conversations/state.ts` — 新增 action

- detail：`conversations/messageAppended` `{message: MessageResponse}` → 把消息 push 进 `messages`（发送后立即插入服务端返回的真实 user message）。
- index：`conversations/draftCreated` `{id: number}` → `draftId = id`；`conversations/draftActivated` → `draftId = null`。

`composer` 切片本轮不动。

### `conversations/useConversationLoader.ts` — 切换会话清空流式态

`selectConversation` 与 `newConversation` 在切换 / 新建时派发 `run/cleared`，使离开当前会话即丢弃流式 / 失败 partial（与「partial 跨导航不保留」一致，并防止返回时陈旧 partial 重现）。与上面的 null no-op 配合：切走后 in-flight 事件不再复活 activeRun。

## 编排（hooks）

### `runs/useRunStream.ts` — 做实

返回 `start(runId, conversationId, afterSeq)`：

1. 建 `AbortController` 存入 ref（卸载时 abort）。
2. 异步迭代 `runApi.streamEvents(runId, afterSeq, {signal})`。
3. `run_started` 忽略；`reasoning_delta` / `text_delta` → 派发 `run/reasoningDelta` / `run/textDelta`（取 `event.data.payload.text`，缺失时按空串）。
4. 终态：派发 `run/terminal{status}`，并：
   - **succeeded**：`await conversationApi.detail(conversationId)` + `conversationApi.list()` → 派发 `conversations/listLoaded` + `conversations/draftActivated` + `run/cleared`（均无条件）；**仅当用户仍停留在该会话**（`selectedIdRef.current === conversationId`）时才派发 `conversations/detailLoaded`，否则跳过——避免把 A 的助手消息覆盖到用户已切去的 B（用户返回 A 时 `selectConversation` 会重拉到含助手消息的最新 detail）。
   - **failed / cancelled**：保留 `activeRun`（partial 与状态文字可见），不重拉、不清理；输入恢复。
5. 异常：`AbortError` 静默停止；其它 stream 错误按 `failed` 处理（派发 `run/terminal{failed}`）。

`useRunStream` 通过 `useAppActions().services` 直接拿 `conversationApi` / `runApi` 做成功重拉，不复用 `selectConversation`（后者含选择持久化等多余副作用）。`selectedIdRef` 每次渲染同步 `conversationIndex.selectedId`，供终态回调读取最新选择。

### `conversations/useSendMessage.ts`（新增）

返回 `send(content)`：

1. `content.trim()` 为空 → return。
2. 确保有会话：
   - 无选中（`selectedId == null`）→ `const convo = await conversationApi.create()`；派发 `conversations/detailLoaded{conversation: convo, messages: []}` + `conversations/selected{id: convo.id}` + `conversations/draftCreated{id: convo.id}`；`selectionStore.save(convo.id)`；`targetId = convo.id`。
   - 否则 `targetId = selectedId`。
3. `const {message, run} = await conversationApi.sendMessage(targetId, content)`。
4. 派发 `conversations/messageAppended{message}`（用户消息），清空 Composer 输入。
5. 派发 `run/started{runId: run.id, conversationId: targetId}`，调 `start(run.id, targetId, 0)` 开流。
6. 步骤 2 / 3 抛错：保留输入、不启动流、不崩溃（用户可重试）；本轮仅 `console` + 恢复，中文错误提示走步骤 11 Toast。

AppShell 组合 `useSendMessage` 与 `useRunStream`，把 `send` 与 `disabled` 传入 Composer。

## 展示组件

### `messages/StreamingMessage.tsx`（新增）

仅当 `activeRun != null && activeRun.conversationId === selectedId` 时渲染，挂在 `MessageThread` 之后。复用助手消息版式：
- `draftReasoning` 非空 → `ThinkingBlock`，`streaming = (status ∈ {started, streaming}) && draftText === ""`（思考阶段展开「思考中…」，正文一到自动收起为「已思考」）。
- `draftText` → `Markdown`。
- `status === "failed"` → 末尾一行 `生成失败`；`status === "cancelled"` → `已停止`（小号状态文字，新增最小 `.run-status` 样式，置于 `chat.css`）。

### `messages/ThinkingBlock.tsx` — 小改

加一个随 `streaming` 翻转的 effect：`streaming` 真 → 展开，假 → 收起；期间仍允许手动切换。使「正文到达 → 自动收起」生效，历史消息（`streaming` 恒为 false）默认收起。

### `ui/Composer.tsx` — 接线

新增 props `onSubmit(text: string)` 与 `disabled: boolean`：
- Enter（非 Shift、非 `isComposing`）→ `onSubmit(value)` 并清空；Shift+Enter 换行。
- 发送按钮：`value.trim() !== "" && !disabled` 时可用，点击 → `onSubmit`。
- `disabled` 由 AppShell 传入：`activeRun?.conversationId === selectedId && activeRun.status ∈ {queued, started, streaming}`（成功 / 失败后即恢复）。

### 自动滚动

`messages/useStickToBottom.ts`（新增）：接收滚动容器 ref，near-bottom（阈值约 80px）时，在 `messages.length` / `activeRun.draftText` / `activeRun.draftReasoning` 变化后贴底；用户上滚阅读历史时不强制拉回。挂在 thread 容器。

## 数据流

### Happy path

输入 → `send` →（无选中则建草稿）→ `sendMessage` → 插入用户消息 + 清空输入 → `run/started` → `start` 开流 → reasoning/text delta 累加（思考中 → 正文到达收起、near-bottom 贴底）→ `run_succeeded` → 重拉 detail + list → `detailLoaded`（真实助手消息）+ `draftActivated` + `run/cleared` → 流式气泡消失、服务端消息接管、侧栏出现该会话。

### Failure path

…→ `run_failed` 或流错误 → `run/terminal{failed}` → partial 保留、显示 `生成失败`、输入恢复。（切换会话 / 刷新会丢该 partial —— 步骤 9 再补 partial 持久化与刷新恢复。）

## 错误处理

- 发送前（create / sendMessage）失败：保留输入、不开流、不崩溃，允许重试；无 Toast（步骤 11）。
- 流中 provider 失败（`run_failed`）或网络错误：按 failed 最小处理。
- `AbortError`（卸载 / 导航）：静默停止，不视为失败。
- 403 / 404 等会话失效仍走既有 `selectConversation` 的静默清理（本轮不改）。

## 非目标（明确留给后续步骤）

- 「停止生成」按钮与 `runApi.cancel`（步骤 9）。
- 进行中 run 的刷新恢复（`runApi.state` + `after_seq` 续流）（步骤 9）。
- partial 内容跨导航 / 刷新保留（步骤 9）。
- 编辑并重发 / 重新生成（步骤 10）。
- 自动标题 pending 骨架与轮询（步骤 10）。
- Toast / BottomSheet（步骤 11）。
- 并发 run 的 UI 守卫——后端保证每会话单 active run，UI 仅在流式中禁用发送。
- ComposerState 的 reducer 化（随步骤 9）。

## 测试策略

按 TDD，每项 RED → GREEN → commit。全部通过 `createFakeServices` 注入 fake，不触达真实 HTTP / SSE。

- `activeRunReducer`：started、reasoningDelta 累加、textDelta 累加、terminal × 3、cleared、app/reset、`state === null` 时 delta/terminal 为 no-op。
- conversations reducer：`messageAppended`、`draftCreated` / `draftActivated`。
- `useConversationLoader`：`selectConversation` / `newConversation` 派发 `run/cleared`（已有用例基础上补断言）。
- `useRunStream`：用可控的 fake `streamEvents` 异步生成器驱动 → 断言 delta 派发、succeeded 触发 detail + list 重拉与 `cleared`、failed 保留 activeRun、`AbortError` 静默、**run 终态时用户已切到别的会话则不派发 `detailLoaded`（但仍 list + cleared）**。
- `useSendMessage`：无选中 → 建草稿全链路（create + detailLoaded + selected + draftCreated + save）；已选中路径；空内容 guard；`sendMessage` 失败保留输入。
- `Composer`：Enter 提交 / Shift+Enter 换行 / IME 不提交 / 流式中 disabled / 非空启用。
- `StreamingMessage`：渲染 Markdown + 思考；failed 显示 `生成失败`、cancelled 显示 `已停止`；仅当 activeRun 属于当前会话时渲染。
- `ThinkingBlock`：`streaming` true→false 自动收起，且期间可手动切换。
- `useStickToBottom`：near-bottom 时贴底、上滚时不打断（基于可控 scroll 容器断言）。
- AppShell 集成：fake 流跑通一条 happy path（输入 → 发送 → 看到流式正文 → 终态被服务端消息替换）。

### 测试基建

`src/test/appHarness.tsx` 的 `createFakeServices` 增加 `runApi`：新增 `createFakeRunApi`，提供
- 默认数组驱动的 `streamEvents`（同步产出一组预设事件），
- 一个可手动逐条推送事件、由测试控制终止时机的受控变体（供时序断言用），
- `state` / `cancel` 桩。

`createFakeServices(authApi, conversationApi, runApi)` 第三参数注入；`renderWithApp` / `makeWrapper` 同步透传。

## 验证

```bash
cd frontend
pnpm exec vitest run    # 全部通过，测试数从 115 继续增长
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过
```

可选本地跨域 smoke：起后端（`VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1`、`CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`）+ `pnpm dev`，手动发一条消息看流式与终态替换。

## 关联文档

- 前序交接：`docs/handover/frontend/2026-06-08-frontend-conversation-list-and-detail.md`
- 前序 spec：`docs/superpowers/specs/2026-06-08-frontend-conversation-list-and-detail-design.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
- 后端 Run events / SSE replay：`docs/handover/2026-05-17-run-events-sse-replay.md`
- 草稿对话与自动标题：`docs/handover/2026-05-20-auto-title-and-draft-conversation.md`
