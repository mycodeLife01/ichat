# 2026-06-09 前端发送消息与 SSE 基础流式交接文档

## 本次完成

按 `docs/superpowers/plans/2026-06-09-frontend-send-and-sse-streaming.md` 完整实现重构总计划第 8 步：**发送消息 + SSE 基础流式**。在会话列表 + 只读详情外壳之上，打通「输入发送 → 立即显示用户消息 → 实时流式渲染思考过程与正文 → run 成功后服务端物化消息替换流式气泡 → 侧栏刷新」的最小闭环。

随严格复刻 `chatapp_demo` 的 Composer 三态，「停止生成」按钮（原属步骤 9）以最小可用版提前落地：点击经 `runApi.cancel` 取消，等服务端 `run_cancelled` 终态后显示「已停止」。失败 / 取消保留 partial 内容、显示对应 `.status-pill`、恢复输入；不做重试与重连。

实施采用 TDD：11 个功能任务逐个 RED → GREEN → commit（`8bbb7ce`..`fa75887`），随后 5 个交互 / 视觉修复提交（`d8f3acc`..`2522c0d`）。前端测试从 115 增至 **151 全绿**（36 个测试文件）。

## 主要改动

### 状态层

- `src/runs/state.ts`：`activeRunReducer` 做实。`run/started`（整体置初值，覆盖旧 activeRun）、`run/reasoningDelta` / `run/textDelta`（累加 draft、推进 `latestSeq`、status 转 `streaming`）、`run/terminal`（置终态但**保留** drafts）、`run/cancelRequested`（乐观置 `cancelling`）、`run/cleared`、`app/reset`。delta / terminal / cancelRequested 在 `state === null` 时为 no-op（防御用户已切走会话后 in-flight 事件迟到）。AbortController 刻意不入 reducer。
- `src/conversations/state.ts`：detail 新增 `conversations/messageAppended`（发送后立即插入服务端返回的真实 user message）；index 新增 `conversations/draftCreated` / `conversations/draftActivated`（`draftId` 生命周期）。
- `src/app/store.ts`：`AppAction` 联合纳入 `ActiveRunAction`。
- `src/conversations/useConversationLoader.ts`：`selectConversation` / `newConversation` 切换时派发 `run/cleared`——离开当前会话即丢弃流式 / 失败 partial，与 null no-op 配合防止陈旧 partial 复活。

### 编排（hooks）

- `src/runs/useRunStream.ts`（做实）：返回 `{ start, cancel }`。`start` 异步迭代 `runApi.streamEvents`，delta 派发对应 action；`run_succeeded` 后重拉 detail + list，无条件派发 `listLoaded` + `draftActivated` + `run/cleared`，但**仅当用户仍停留在该会话**（`selectedIdRef`）才派发 `detailLoaded`，避免 A 的回复覆盖用户已切去的 B；failed / cancelled 保留 activeRun 不重拉；`AbortError` 静默，其它流错误按 failed 处理。`cancel` 派发 `run/cancelRequested` + 调 `runApi.cancel`（失败吞掉），**不**主动 abort 本地流——等服务端 `run_cancelled` 经 SSE 驱动终态。abort 经既有 `streamAbort` 注册，logout / 身份失效自动断流。
- `src/conversations/useSendMessage.ts`（新增）：`send(content)` —— 空内容 guard → 无选中时建草稿（`create` + `detailLoaded` + `selected` + `draftCreated` + `selectionStore.save`）→ `sendMessage` → `messageAppended` + `run/started` → 调注入的 `start` 开流。发送前失败仅 console + 保留输入（Toast 留步骤 11）。`start` 由 AppShell 注入（单一 `useRunStream` 实例），hook 本身不含流式接线、可用 spy 测试。

### 展示组件

- `src/messages/StreamingMessage.tsx`（新增）：流式助手气泡，仅当 `activeRun.conversationId === selectedId` 时挂在 `MessageThread` 之后。结构逐项对齐 demo 助手分支：思考区 / `.body.md` / 流式 `.caret` / `.status-pill.stopped`「已停止」/ `.status-pill.failed`「生成失败 · 请稍后重试」。
- `src/messages/ThinkingBlock.tsx`：加随 `streaming` 翻转的 effect——思考阶段展开「思考中…」，正文到达自动收起为「已思考」，期间可手动切换。
- `src/ui/Composer.tsx`：改为 demo props 形状 `{ value, onChange, onSend, onStop, state }`，三态 `idle / streaming / stopping`。idle 渲染 `.send-btn`（空内容禁用），否则 `.stop-btn`（stopping 禁用，`aria-label` 为「停止中」/「停止生成」）。Enter 发送、Shift+Enter 换行、IME composing 不发送。textarea 自动增高（上限 240px）。
- `src/messages/MessageThread.tsx`:接受 `children`（流式气泡插槽）。
- `src/messages/useStickToBottom.ts`（新增）：near-bottom（阈值 80px）时随消息 / draft 变化贴底，用户上滚阅读不打断；`isNearBottom` 纯函数可独立测试。

### 装配与测试基建

- `src/api/runs.ts` 导出 `RunApi` 类型；`Services` 增加 `runApi`；`AppProvider` 真实分支装配 `createRunApi(client)`。
- `src/test/appHarness.tsx`：新增 `createFakeRunApi` 与 `fakeStream(events)`（数组驱动的异步生成器）；`createFakeServices` 接受第三参数注入 fake runApi。
- `src/app/AppShell.tsx`：实例化 `useRunStream` + `useSendMessage`，派生 Composer 三态，接线 `onSend` / `onStop` / `StreamingMessage` / `useStickToBottom`；`showWelcome` 在有 activeRun 时不显示。

## 关键文件

- `frontend/src/runs/useRunStream.ts`：流式消费唯一入口。终态编排（成功重拉替换 / 失败保留）与「切走不覆盖」语义都在这里。
- `frontend/src/conversations/useSendMessage.ts`：发送链路编排（草稿创建、消息插入、开流）。
- `frontend/src/messages/StreamingMessage.tsx`：临时流式气泡；服务端 `conversationDetail.messages` 始终是事实源，流式内容只活在 `activeRun` 切片。
- `frontend/src/app/AppShell.tsx`：单一 `useRunStream` 实例的拥有者；Composer 三态派生逻辑。

## 设计决策

### 方案 A：activeRun 独立切片 + 临时气泡（spec 已确认）

`conversationDetail.messages` 保持服务端事实源，流式草稿由独立 `activeRun` 切片驱动、渲染为挂在消息列表之后的临时 `StreamingMessage`；成功路径是干净的「重拉替换」。不合成占位消息塞进 `messages`（污染事实源、终态需对账），也不把草稿折叠进 detail 切片（run 生命周期是步骤 9 需要独立拥有的关注点）。

### 取消不 abort 本地流

`cancel` 只乐观置「停止中」+ 发 cancel 请求；本地 SSE 流继续读，直到服务端 `run_cancelled` 终态事件到达才显示「已停止」。这符合「terminal 到达前不显示已停止」的产品语义，且取消请求失败时终态仍会经 SSE 到达（本轮失败仅吞掉，中文反馈留步骤 9 / 11）。

### 严格复刻 chatapp_demo

标记、类名、文案逐项对齐 demo（`.caret` / `.status-pill(.stopped/.failed)` / `.stop-btn` / `.body.md`），组件测试以 demo 类名作断言锚点。计划原则「本轮不新增 CSS」基本守住，唯一例外见下文修复 5。

## 计划外修复 / 偏差

实现后手动验证发现并修复 5 处（独立提交）：

1. **`d8f3acc`** restore effect 依赖数组补入稳定的 `dispatch`（`AppProvider.tsx`），消除 lint / 闭包隐患。
2. **`be3317d`** 重复点击侧栏当前会话不再触发冗余 detail 重拉：`selectConversation` 对 `selectedId` 相同的入参 early-return；「重新加载当前会话」语义改为显式页面刷新。
3. **`19b9ab4`** 思考区头部简化：去掉左侧竖线使「已思考」与正文齐平，去掉流式中的闪烁圆点。**对 demo 的有意视觉偏差。**
4. **`abda025`** Markdown 代码块背景从近黑改为暖白 + 边框，与聊天表面融合。**对 demo 的有意视觉偏差。**
5. **`2522c0d`** 进入已有会话时聊天列不再抖动：(a) composer 居中 → 底部的过渡动画曾因 `showWelcome` 在 detail 加载期间短暂翻转而误重放，改为仅在全新会话发出首条消息时由 AppShell 添加 `.composer-animate` 类（**新增了一个 CSS 类**，是对「不新增 CSS」的必要突破）；(b) 展开思考块导致滚动条出现 / 消失挤窄列宽，给 `.thread-region` 与 `.thinking-body` 加 `scrollbar-gutter: stable`。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 151 个测试全部通过（36 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过，产物输出到 frontend/dist/
```

（以上为 2026-06-10 交接时复跑结果。）

测试矩阵（本次新增）：activeRunReducer（started / delta 累加 / terminal 保留 drafts / cancelRequested / cleared / reset / null no-op）、conversations 切片新 action、useConversationLoader 切换清流式态、useRunStream（成功重拉替换 / 切走不覆盖 / 失败不重拉 / cancel 转 stopping）、useSendMessage（建草稿全链路 / 已选中直发 / 空内容 / 发送失败）、ThinkingBlock 自动收起、StreamingMessage（正文 / caret / 思考 / failed / stopped pill）、Composer（三态 / Enter / Shift+Enter / IME）、isNearBottom、AppShell 集成（发送 → 流式 → 服务端替换；流式中 stop-btn 取代发送）。

## 当前边界

已完成：

- 空白态（自动建草稿）或已选中会话发送消息，思考与正文实时流式，正文到达思考区自动收起。
- run 成功后服务端物化消息替换流式气泡，侧栏出现该会话（草稿激活）。
- 停止生成最小可用：streaming → stopping →「已停止」；失败显示「生成失败 · 请稍后重试」；两者均保留 partial、恢复输入。
- near-bottom 自动贴底；切换 / 新建会话清空流式态，流式中途切走不污染当前详情。

未完成，留给后续步骤（对应总计划步骤 9–13）：

- **刷新恢复（步骤 9）**：启动时识别进行中 run（`runApi.state` + `draft_text` / `draft_reasoning` 回填 + `after_seq` 续流）；partial 跨导航 / 刷新保留；cancel 失败的中文反馈与重试。
- **编辑 / 重新生成 + 自动标题（步骤 10）**：放开 Message 的禁用按钮接对应 API；`pendingTitleIds` 驱动标题骨架与轮询。
- **Toast / BottomSheet（步骤 11）**：demo 的 `.sheet-*` / `.toast` 样式尚未移植。
- **CI/CD、部署文档、最终 smoke（步骤 12–13）**。

## 注意事项

- 流式内容只存在于 `activeRun` 切片，刷新即丢——步骤 9 用后端 `run.state` 的 `draft_text` / `draft_reasoning` 恢复（后端已持久化并在 state 响应中返回 `draft_reasoning`）。
- `useRunStream` 的 `selectedIdRef` 每次渲染同步最新选择，终态回调据此决定是否应用 detail；改动选择逻辑时注意保持该 ref 语义。
- `activeRunReducer` 的 null no-op 是「切走后 in-flight 事件不复活 activeRun」的另一半，不要移除。
- `.composer-animate` 仅在全新会话发首条消息时添加；如调整 composer 布局动画，先看 `2522c0d` 的提交说明。
- AppShell 仍持有 `useRunStream` 的唯一实例；如新增需要 `start` / `cancel` 的入口（如步骤 10 的重新生成），从 AppShell 注入，不要二次实例化。

## 关联文档

- 本次对应计划：`docs/superpowers/plans/2026-06-09-frontend-send-and-sse-streaming.md`
- 对应 spec：`docs/superpowers/specs/2026-06-09-frontend-send-and-sse-streaming-design.md`
- 前序交接：`docs/handover/frontend/2026-06-08-frontend-conversation-list-and-detail.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
- 后端 Run events / SSE replay：`docs/handover/2026-05-17-run-events-sse-replay.md`
