# 前端发送消息与 SSE 基础流式设计

日期：2026-06-09

## 目标

承接 `2026-06-08-frontend-conversation-list-and-detail-design.md`（已实现：会话列表 + 只读详情 + 会话管理）。本设计落地前端重构总计划（`2026-05-24-frontend-react-rebuild-design.md`）第 8 步：**发送消息 + SSE 基础流式**。

用户在选中会话或空白（草稿）态下输入并发送 → 立即显示用户消息 → 实时流式渲染助手的思考过程与正文 → run 成功后用服务端物化的真实助手消息替换流式气泡，并刷新侧栏列表。流式中 Composer 显示停止按钮，点击经 `runApi.cancel` 最小取消，等 `run_cancelled` 终态显示「已停止」。失败 / 取消保留 partial、显示对应 `.status-pill`、恢复输入，不做重试与重连。**全部 UI 严格复刻 `chatapp_demo`**（标记、类名、文案、交互逐项对齐）。

这是整个剩余重构工作（刷新恢复、编辑 / 重新生成、自动标题）的基石：run 生命周期的状态转移、`useRunStream` 流式消费、Composer 发送链路在本轮全部打通并被测试覆盖，后续步骤在其上扩展。

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
| UI/UX 复刻 | **严格复刻 `chatapp_demo`**：标记、类名、文案、交互密度逐项对齐 `chatapp_demo/components.jsx` 与 `styles.css`；计划验证阶段需逐项核对并做视觉 smoke |
| 失败终态处理深度 | 最小处理：停流、保留 partial 正文 / 思考、显示 `.status-pill failed`（`生成失败 · 请稍后重试`）、恢复输入；不重试、不重连 |
| 流式助手内容的渲染方式 | 方案 A：`conversationDetail.messages` 保持服务端事实源；流式内容由独立的 `activeRun` 切片驱动、渲染为挂在消息列表之后的临时气泡（复用 demo 的 `.caret` + `.status-pill` 标记）；成功后重拉 detail 替换 |
| 停止生成 | 纳入本轮**最小可用**（与严格复刻一致）：Composer 按 demo 渲染 `idle/streaming/stopping` 三态；`onStop` 调 `runApi.cancel(runId)` + 置 `cancelRequested`，等服务端 `run_cancelled` 终态后显示 `.status-pill stopped`（`已停止`）。`cancelRequested` 期间按钮显示「停止中」且禁用。刷新恢复仍留步骤 9 |
| 自动滚动 | 纳入本轮，最小 near-bottom 跟随（用户上滚阅读时不打断） |
| ComposerState reducer 化 | 本轮不做，`composer.input` 留在 AppShell 局部 state |

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
| `run/cancelRequested` | 置 `cancelRequested:true`、`status:"cancelling"`（乐观态，等服务端 `run_cancelled` 才真正终止） |
| `run/cleared` | → `null` |
| `app/reset` | → `null`（已有） |

`run/reasoningDelta` / `run/textDelta` / `run/terminal` / `run/cancelRequested` 在 `state === null` 时为 no-op（防御性：用户已切走会话清空了 activeRun，但 in-flight 事件仍在到达）。

### `conversations/state.ts` — 新增 action

- detail：`conversations/messageAppended` `{message: MessageResponse}` → 把消息 push 进 `messages`（发送后立即插入服务端返回的真实 user message）。
- index：`conversations/draftCreated` `{id: number}` → `draftId = id`；`conversations/draftActivated` → `draftId = null`。

`composer` 切片本轮不动。

### `conversations/useConversationLoader.ts` — 切换会话清空流式态

`selectConversation` 与 `newConversation` 在切换 / 新建时派发 `run/cleared`，使离开当前会话即丢弃流式 / 失败 partial（与「partial 跨导航不保留」一致，并防止返回时陈旧 partial 重现）。与上面的 null no-op 配合：切走后 in-flight 事件不再复活 activeRun。

## 编排（hooks）

### `runs/useRunStream.ts` — 做实

返回 `{ start, cancel }`。

`start(runId, conversationId, afterSeq)`：

1. 建 `AbortController`，经 `streamAbort.register(() => controller.abort())` 注册（既有基建：logout / 身份失效已调 `streamAbort.abort()`，无需另写卸载 effect）。
2. 异步迭代 `runApi.streamEvents(runId, afterSeq, {signal})`。
3. `run_started` 忽略；`reasoning_delta` / `text_delta` → 派发 `run/reasoningDelta` / `run/textDelta`（取 `event.data.payload.text`，缺失时按空串）。
4. 终态：派发 `run/terminal{status}`，并：
   - **succeeded**：`await conversationApi.detail(conversationId)` + `conversationApi.list()` → 派发 `conversations/listLoaded` + `conversations/draftActivated` + `run/cleared`（均无条件）；**仅当用户仍停留在该会话**（`selectedIdRef.current === conversationId`）时才派发 `conversations/detailLoaded`，否则跳过——避免把 A 的助手消息覆盖到用户已切去的 B（用户返回 A 时 `selectConversation` 会重拉到含助手消息的最新 detail）。
   - **failed / cancelled**：保留 `activeRun`（partial 与 `.status-pill` 可见），不重拉、不清理；输入恢复。
5. 异常：`AbortError` 静默停止；其它 stream 错误按 `failed` 处理（派发 `run/terminal{failed}`）。

`cancel(runId)`：派发 `run/cancelRequested`（乐观置「停止中」），`await runApi.cancel(runId)`（失败吞掉，终态仍会经 SSE 到达）。**不**主动 abort 本地流——等服务端 `run_cancelled` event 经 SSE 到达，再走终态显示「已停止」（符合「terminal 到达前不显示已停止」）。

`useRunStream` 通过 `useAppActions().services` 直接拿 `conversationApi` / `runApi`，不复用 `selectConversation`（后者含选择持久化等多余副作用）。`selectedIdRef` 每次渲染同步 `conversationIndex.selectedId`，供终态回调读取最新选择。

### `conversations/useSendMessage.ts`（新增）

`useSendMessage(start)` 接收 `useRunStream` 的 `start` 作为参数（AppShell 只实例化一次 `useRunStream`，把 `start` 注入本 hook、把 `cancel` 用于停止），返回 `send(content)`：

1. `content.trim()` 为空 → return。
2. 确保有会话：
   - 无选中（`selectedId == null`）→ `const convo = await conversationApi.create()`；派发 `conversations/detailLoaded{conversation: convo, messages: []}` + `conversations/selected{id: convo.id}` + `conversations/draftCreated{id: convo.id}`；`selectionStore.save(convo.id)`；`targetId = convo.id`。
   - 否则 `targetId = selectedId`。
3. `const {message, run} = await conversationApi.sendMessage(targetId, content)`。
4. 派发 `conversations/messageAppended{message}`（用户消息），清空 Composer 输入。
5. 派发 `run/started{runId: run.id, conversationId: targetId}`，调 `start(run.id, targetId, 0)` 开流。
6. 步骤 2 / 3 抛错：保留输入、不启动流、不崩溃（用户可重试）；本轮仅 `console` + 恢复，中文错误提示走步骤 11 Toast。

AppShell：`const { start, cancel } = useRunStream(); const send = useSendMessage(start);`，把 `onSend` / `onStop` / `state` 传入 Composer。

## 展示组件

> **严格复刻基准**：本节所有标记、类名、文案以 `chatapp_demo/components.jsx` 的 `Message`（助手分支，第 471–571 行）与 `Composer`（第 576–664 行）为准；样式类（`.caret` / `.status-pill.stopped` / `.status-pill.failed` / `.stop-btn` / `.body.md`）已存在于 `frontend/src/styles/chat.css`，**本轮不新增 CSS**。

### `messages/StreamingMessage.tsx`（新增）

仅当 `activeRun != null && activeRun.conversationId === selectedId` 时渲染，挂在 `MessageThread` 之后。结构与 demo 助手消息逐项对齐（`.msg.assistant` → flex 容器 → 思考区 + `.body.md` + caret + status-pill）：
- `draftReasoning` 非空 → `ThinkingBlock`，`streaming = isStreaming && draftText === ""`（思考阶段展开「思考中…」，正文一到自动收起为「已思考」）。
- `draftText` → `Markdown`（输出 `.body.md`）。
- `isStreaming`（`status ∈ {queued, started, streaming, cancelling}`）时，正文后渲染 `<span className="caret" />`（demo 的闪烁光标）。
- `status === "cancelled"` → `<div className="status-pill stopped">`：小方点 span + `已停止`（demo 第 530–535 行原样）。
- `status === "failed"` → `<div className="status-pill failed">`：`<Icons.Close size={12} />` + `生成失败 · 请稍后重试`（demo 第 536–541 行原样）。

### `messages/ThinkingBlock.tsx` — 小改

加一个随 `streaming` 翻转的 effect：`streaming` 真 → 展开，假 → 收起；期间仍允许手动切换。等价于 demo `ThinkingBlock` 的 `autoCollapseOnDone` 行为（demo 第 277–282 行）：正文到达自动收起，历史消息（`streaming` 恒为 false）默认收起。

### `ui/Composer.tsx` — 逐行对齐 demo Composer

改为 demo `Composer` 的 props 形状：`{ value, onChange, onSend, onStop, state }`，`state: "idle" | "streaming" | "stopping"`。
- `send()`：`if (!value.trim() || state !== "idle") return; onSend();`（demo 第 594–597 行）。
- Enter（非 Shift、非 `isComposing`）→ `send()`；Shift+Enter 换行。
- `state === "idle"` → 渲染 `.send-btn`（`disabled={!value.trim()}`，点击 `send`）；否则渲染 `.stop-btn`（`disabled={state === "stopping"}`，点击 `onStop`，`aria-label` 为 `停止中`/`停止生成`），含 `<Icons.Stop size={11} />`（demo 第 640–658 行）。

AppShell 派生 `state`：当 `activeRun?.conversationId === selectedId` 时——`cancelRequested`（即 `status === "cancelling"`）→ `"stopping"`；`status ∈ {queued, started, streaming}` → `"streaming"`；否则 `"idle"`（终态 succeeded/failed/cancelled 后回 `idle`，发送按钮恢复）。`onSend = () => { const t = composerValue; setComposerValue(""); void send(t); }`；`onStop = () => { if (activeRun) void cancel(activeRun.runId); }`。

### 自动滚动

`messages/useStickToBottom.ts`（新增）：接收滚动容器 ref，near-bottom（阈值约 80px）时，在 `messages.length` / `activeRun.draftText` / `activeRun.draftReasoning` 变化后贴底；用户上滚阅读历史时不强制拉回。挂在 thread 容器。

## 数据流

### Happy path

输入 → `send` →（无选中则建草稿）→ `sendMessage` → 插入用户消息 + 清空输入 → `run/started` → `start` 开流 → reasoning/text delta 累加（思考中 → 正文到达收起、near-bottom 贴底）→ `run_succeeded` → 重拉 detail + list → `detailLoaded`（真实助手消息）+ `draftActivated` + `run/cleared` → 流式气泡消失、服务端消息接管、侧栏出现该会话。

### Stop path

流式中点击停止 → `onStop` → `cancel(runId)`：派发 `run/cancelRequested`（按钮转「停止中」、禁用）+ `runApi.cancel(runId)` → 服务端写入 `run_cancelled` → SSE 送达 → `run/terminal{cancelled}` → 保留 partial，显示 `.status-pill stopped`「已停止」，Composer 回 `idle`。

### Failure path

…→ `run_failed` 或流错误 → `run/terminal{failed}` → partial 保留、显示 `.status-pill failed`「生成失败 · 请稍后重试」、输入恢复。（切换会话 / 刷新会丢该 partial —— 步骤 9 再补 partial 持久化与刷新恢复。）

## 错误处理

- 发送前（create / sendMessage）失败：保留输入、不开流、不崩溃，允许重试；无 Toast（步骤 11）。
- 流中 provider 失败（`run_failed`）或网络错误：按 failed 最小处理。
- `AbortError`（卸载 / 导航）：静默停止，不视为失败。
- 403 / 404 等会话失效仍走既有 `selectConversation` 的静默清理（本轮不改）。

## 非目标（明确留给后续步骤）

- 进行中 run 的刷新恢复（`runApi.state` + `after_seq` 续流）（步骤 9）。
- partial 内容跨导航 / 刷新保留（步骤 9）。
- 取消的健壮化：cancel 请求失败的中文错误反馈与重试（步骤 9 / 11）；本轮 cancel 失败仅吞掉，依赖 SSE 终态。
- 编辑并重发 / 重新生成（步骤 10）。
- 自动标题 pending 骨架与轮询（步骤 10）。
- Toast / BottomSheet（步骤 11）。
- 并发 run 的 UI 守卫——后端保证每会话单 active run，UI 仅在流式中以停止按钮取代发送。
- ComposerState 的 reducer 化。

> 注：「停止生成」按钮 + `runApi.cancel` 原属步骤 9，因严格复刻 demo Composer 的 `stopping` 三态而提前到本轮（最小可用版）。

## 测试策略

按 TDD，每项 RED → GREEN → commit。全部通过 `createFakeServices` 注入 fake，不触达真实 HTTP / SSE。

- `activeRunReducer`：started、reasoningDelta 累加、textDelta 累加、terminal × 3、cancelRequested（status cancelling）、cleared、app/reset、`state === null` 时 delta/terminal/cancelRequested 为 no-op。
- conversations reducer：`messageAppended`、`draftCreated` / `draftActivated`。
- `useConversationLoader`：`selectConversation` / `newConversation` 派发 `run/cleared`。
- `useRunStream`：用可控的 fake `streamEvents` 异步生成器驱动 → 断言 delta 派发、succeeded 触发 detail + list 重拉与 `cleared`、failed 保留 activeRun、`AbortError` 静默、**run 终态时用户已切到别的会话则不派发 `detailLoaded`（但仍 list + cleared）**；`cancel` 派发 `cancelRequested` 并调 `runApi.cancel`。
- `useSendMessage`：无选中 → 建草稿全链路（create + detailLoaded + selected + draftCreated + save）；已选中路径不建草稿；空内容 guard；`sendMessage` 失败保留输入。
- `Composer`：Enter 提交 / Shift+Enter 换行 / IME 不提交；`state==="idle"` 非空启用 send-btn；`state==="streaming"` 渲染 stop-btn（点击 onStop）；`state==="stopping"` stop-btn 禁用。
- `StreamingMessage`：渲染 `.body.md` + 思考；流式中有 `.caret`；failed 显示 `.status-pill.failed`「生成失败 · 请稍后重试」、cancelled 显示 `.status-pill.stopped`「已停止」；仅当 activeRun 属于当前会话时渲染。
- `ThinkingBlock`：`streaming` true→false 自动收起，且期间可手动切换。
- `useStickToBottom`：near-bottom 时贴底、上滚时不打断（`isNearBottom` 纯函数断言）。
- AppShell 集成：fake 流跑通一条 happy path（输入 → 发送 → 看到流式正文 → 终态被服务端消息替换）；并断言流式中出现 stop-btn、点击后转「停止中」。

### 测试基建

`src/test/appHarness.tsx` 的 `createFakeServices` 增加第三参数 `runApi`：新增 `createFakeRunApi`（`state` / `cancel` 桩 + 默认空 `streamEvents`）与 `fakeStream(events)` 数组驱动的异步生成器助手。`renderWithApp` / `makeWrapper` 同步透传。

## 严格复刻 chatapp_demo

UI/UX 以 `chatapp_demo` 为唯一基准，实现阶段只做生产化（接真实 state/API），不重新设计：

- 标记与类名逐项对齐 `chatapp_demo/components.jsx`：`Message` 助手分支（思考区 / `.body.md` / `.caret` / `.status-pill`）、`Composer`（`.send-btn` ↔ `.stop-btn` 三态）、`ThinkingBlock`（自动收起）。
- 文案原样：`思考中…` / `已思考` / `已停止` / `生成失败 · 请稍后重试` / 占位「有问题，尽管问」 / stop 按钮 `停止生成`·`停止中`。
- 样式不新增：`.caret` / `.status-pill(.stopped/.failed)` / `.stop-btn` / `.body.md` 均已在 `frontend/src/styles/chat.css`（由前序步骤从 demo 移植）。如发现缺失类，从 `chatapp_demo/styles.css` 对应段补齐，不自创。
- 自动化保真断言：组件测试以 demo 类名（`.caret` / `.status-pill.failed` / `.status-pill.stopped` / `.stop-btn`）作为断言锚点。
- 视觉 smoke（验证阶段必做）：浏览器并排打开 `chatapp_demo/index.html` 与本地运行的应用，逐项比对流式气泡、光标、思考折叠、停止按钮、状态 pill 的外观与交互。

## 验证

```bash
cd frontend
pnpm exec vitest run    # 全部通过，测试数从 115 继续增长
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过
```

复刻保真验证（必做）：按「严格复刻 chatapp_demo」节，跑组件测试的类名锚点断言 + 浏览器并排视觉 smoke。本地跨域 smoke：起后端（`VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1`、`CORS_ALLOWED_ORIGINS` 含 `http://localhost:5173`）+ `pnpm dev`，手动发消息看流式、停止、终态替换，并与 demo 比对。

## 关联文档

- 前序交接：`docs/handover/frontend/2026-06-08-frontend-conversation-list-and-detail.md`
- 前序 spec：`docs/superpowers/specs/2026-06-08-frontend-conversation-list-and-detail-design.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
- 后端 Run events / SSE replay：`docs/handover/2026-05-17-run-events-sse-replay.md`
- 草稿对话与自动标题：`docs/handover/2026-05-20-auto-title-and-draft-conversation.md`
