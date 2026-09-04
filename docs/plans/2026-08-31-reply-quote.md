# 回复引用功能可执行实施计划

日期：2026-08-31

状态：已实施（2026-08-31；功能定向验证通过，全量回归限制见交接文档）

需求规格：[`docs/specs/2026-08-31-reply-quote.md`](../specs/2026-08-31-reply-quote.md)

后续修正：2026-09-04 的 UI 验收发现选区展示时机、浮层几何、发送后引用宽度/三行限制、Composer 背景和 SVG 与当前参考不一致；增量实施以 [`docs/plans/2026-09-04-reply-quote-ui-parity.md`](./2026-09-04-reply-quote-ui-parity.md) 为准。本文件继续保留原始实施历史，不再作为这些 UI 细节的最终验收标准。

## 目标

在不改变现有 Run、SSE、Markdown、安全和附件边界的前提下，完成回复引用的端到端闭环：

1. 用户在同一条已完成的 assistant 正文中划选可见文本后，看到严格参考图样式的“询问Piko”浮动按钮。
2. 点击后把单个回复引用放入当前会话 Composer；再次引用时直接替换，不提示。
3. 回复引用允许独立发送；没有用户提示文字时，模型按固定语义解释引用内容，但 UI 不展示该默认行为。
4. 消息、Run 转写、乐观提交、失败恢复、编辑并重新生成、刷新和公开分享都保留同一不可变 excerpt。
5. 发送后的用户消息严格按参考图显示灰色引用行和右对齐用户输入气泡；复制行为遵守已确认规则。
6. 所有关键行为有 API、应用级交互和真实 Chrome 证据，且现有前后端回归全部通过。

## 冻结决策

实施期间不得重新打开以下已确认设计：

- 每条用户消息最多一个回复引用，只能引用当前会话中更早、未归档、已物化的 assistant 正文。
- 浮动按钮始终显示无空格的“询问Piko”；已有引用时直接替换且无提示。
- Composer 引用行只有引用箭头、实际 excerpt 和关闭按钮；不显示标题、卡片或默认解释提示。
- 回复引用 excerpt 最大 4,000 个 Unicode 字符，不静默截断。
- 用户提示文字为空时允许发送，默认语义为“解释这段引用内容”。
- 发送后引用行无背景、边框或标题；提示文字为空时不渲染空气泡。
- 复制时优先只复制用户提示文字；提示文字为空时复制 excerpt。
- MVP 不做多引用、跨消息/跨会话引用、流式回复引用、源码 offset、发送后跳转或 Composer 全文展开。
- 三张稳定参考图位于 `docs/specs/assets/reply-quote/`，是视觉事实源。

## 主要改动面

### 后端

- 数据库与 ORM：`messages` 增加回复引用来源关系和 excerpt 快照。
- API schema：发送请求、编辑请求、消息响应和公开分享响应。
- 会话服务：来源验证、模型输入投影、消息与 Run 原子创建、编辑继承。
- Run 转写：保存模型实际收到的回复引用投影，不从历史来源消息重建。
- 分享服务：冻结 excerpt，但不暴露来源消息标识。

### 前端

- DTO/API：传输可选 `reply_quote`。
- Composer reducer 与本地草稿：按用户和会话隔离回复引用。
- 消息选择层：DOM Selection/Range、浮动动作与来源范围守卫。
- Composer：严格参考图的引用行、关闭与发送守卫。
- 用户消息与分享页：共同的发送后引用展示原语。
- 提交/编辑：乐观消息、失败恢复、引用-only 和不可变继承。
- 真实浏览器 fixture：三种参考状态和 Selection 几何。

## 实施原则

1. 每个阶段先补失败测试，再实现到该阶段测试通过。
2. 后端 API 和数据库先完成可选字段 expand，再接前端创建入口。
3. `messages.content` 始终只保存用户实际输入；隐藏默认解释语义只进入模型输入投影。
4. files 服务继续只接收模型可读文本与附件，不认识 Reply Quote 领域对象。
5. agent 内核、Provider 适配器、Run SSE 和 Markdown parser 不新增回复引用协议。
6. DOM Range、Selection、Popover 坐标和 AbortController 一样不进入 reducer/localStorage。
7. 已发送消息、pending submission 和草稿均使用同一 `ReplyQuote` DTO 形状，避免临时字段漂移。
8. 真实浏览器几何是视觉完成门，jsdom 不作为 Selection 定位或响应式布局证据。

---

## 阶段 0：固定基线与测试入口

### 任务

- [ ] 确认三张参考图可从规格文档正常打开，文件名分别为：
  - `text-selection-action.png`
  - `composer-quote.png`
  - `sent-user-message-quote.png`
- [ ] 记录实施前 `git status --short`，保留与本功能无关的用户改动。
- [ ] 运行后端会话、schema、分享和转写相关基线测试。
- [ ] 运行前端 AppShell、Composer、Message、SharePage、提交与重新生成相关基线测试。
- [ ] 打开现有 `thread-bottom` Playwright fixture，确认 Composer 与正文在桌面/移动项目下仍对齐。

### 基线命令

```bash
uv run pytest -q \
  tests/schemas/test_conversation_schemas.py \
  tests/api/test_conversations.py \
  tests/api/test_shares.py \
  tests/services/conversations/test_service.py \
  tests/services/conversations/test_regenerate.py

cd frontend
pnpm exec vitest run \
  src/app/AppShell.test.tsx \
  src/ui/Composer.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/SharePage.test.tsx \
  src/conversations/useSendMessage.test.tsx \
  src/conversations/useRegenerate.test.tsx
pnpm exec playwright test tests/visual/thread-bottom.visual.ts
```

### 完成门

- 基线全部通过；若存在既有失败，在计划执行记录中写明失败命令、错误和与本功能无关的证据后再继续。

---

## 阶段 1：数据库、领域对象与 API contract

### 1.1 先写 schema 与迁移测试

修改：

- `tests/schemas/test_conversation_schemas.py`
- `tests/api/test_conversations.py`
- 必要时增加针对 ORM 约束的数据库测试

新增失败用例：

- [ ] `MessageCreateRequest` 接受 `content=""` + 合法 `reply_quote`。
- [ ] 请求拒绝空白 excerpt、超过 4,000 字符的 excerpt 和无来源标识的对象。
- [ ] 普通空文字、无附件、无回复引用仍被拒绝。
- [ ] `ConversationCreateWithMessageRequest` 明确拒绝 `reply_quote`。
- [ ] 新的编辑并重新生成请求允许空文字，由服务层结合继承引用/附件判断有效性。
- [ ] 消息响应能返回可选回复引用；来源关系缺失但 excerpt 仍存在时，响应保留 excerpt 并返回空来源标识。

### 1.2 新增迁移与 ORM 字段

修改：

- `alembic/versions/20260831_0021_add_reply_quotes.py`（新建）
- `app/models/conversation.py`

实施：

- [ ] 为 `messages` 增加 `reply_quote_source_message_id BIGINT NULL`，自引用 `messages.id`，删除来源时 `SET NULL`。
- [ ] 增加 `reply_quote_excerpt TEXT NULL`。
- [ ] 增加约束：来源非空时 excerpt 必须非空；excerpt 非空时消息角色必须为 `user`；excerpt 长度为 1–4,000 且不能全为空白。
- [ ] ORM 增加只读/明确 foreign key 的来源 relationship，使用可在 async 查询后安全读取的 eager 策略，避免 `message_response()` 触发 lazy IO。
- [ ] downgrade 只删除本功能新增约束、外键和列，不改写旧消息。

### 1.3 拆分请求/响应 schema

修改：

- `app/schemas/conversations.py`
- `app/schemas/shares.py`

实施：

- [ ] 新增 Reply Quote 请求 schema：来源 assistant 消息公开 UUID + excerpt。
- [ ] 新增 Reply Quote 响应 schema：可空来源消息公开 UUID + excerpt。
- [ ] 把共同的 `content`、附件与 Run options 提取为不带“至少一种输入”判断的基础请求。
- [ ] `MessageCreateRequest` 增加 `reply_quote`，按“文字/附件/引用至少一种”校验。
- [ ] `ConversationCreateWithMessageRequest` 不暴露 `reply_quote`，继续只允许文字或附件。
- [ ] 新增 `MessageEditAndRegenerateRequest`，不暴露可替换的 `reply_quote`；有效输入由目标消息继承事实决定。
- [ ] `MessageResponse` 增加可选 `reply_quote`。
- [ ] `SharedMessage` 增加只含 excerpt 的可选回复引用，不包含来源消息 ID。

### 1.4 消息响应投影

修改：

- `app/services/conversations/service.py`

实施：

- [ ] `message_response()` 从 ORM 消息及来源 relationship 构造回复引用投影。
- [ ] 更新所有 `message_response()` 调用点，保证详情、发送、编辑并重新生成和其他返回路径形状一致。
- [ ] 对无回复引用消息保持原响应兼容；API 继续使用 `response_model_exclude_none` 的现有策略。

### 验证

```bash
uv run pytest -q tests/schemas/test_conversation_schemas.py tests/api/test_conversations.py
uv run ruff check app/models/conversation.py app/schemas/conversations.py app/schemas/shares.py
uv run mypy app
```

在一次性测试数据库验证迁移：

```bash
uv run alembic upgrade head
uv run alembic downgrade 20260830_0020
uv run alembic upgrade head
```

### 完成门

- schema 能表达普通发送、回复引用发送和不可变编辑三种 contract。
- 迁移 upgrade/downgrade/upgrade 成功。
- 旧请求和旧消息响应测试不需要修改语义即可通过。

---

## 阶段 2：后端来源验证、模型输入与 Run 转写

### 2.1 先写会话/API 高层测试

修改：

- `tests/api/test_conversations.py`
- `tests/services/conversations/test_service.py`
- 需要时补充 `tests/worker/test_executor.py` 或 transcript/history 既有测试

新增失败用例：

- [ ] 在同一会话引用更早 assistant 消息，引用-only 请求创建一条 user message 和 queued Run。
- [ ] 引用+提示文字保留原 `content` 和 excerpt。
- [ ] 来源属于其他用户、其他会话、user 消息、已归档消息或位置不早于新消息时拒绝。
- [ ] 非法来源统一返回稳定 code，不泄露其他用户/会话中的消息是否存在。
- [ ] excerpt 去除首尾空白、CRLF 统一为 LF，内部缩进和换行保留。
- [ ] 普通消息转写与实施前完全一致。
- [ ] 回复引用模型输入包含完整 excerpt 和用户提示文字。
- [ ] 引用-only 模型输入包含默认解释意图，但数据库 `messages.content` 仍为空。
- [ ] 回复引用参与 token counter；超预算按既有目标 turn 过大错误拒绝。
- [ ] excerpt 中的“不要搜索”不会影响只基于用户提示文字计算的网页搜索选项。

### 2.2 新增会话层 Reply Quote helper

修改：

- `app/services/conversations/service.py`
- 如 service 继续膨胀，可在 `app/services/conversations/` 内新增私有 `reply_quotes.py`，但不建立跨模块公开 API

实施：

- [ ] 定义稳定错误 code，例如 `REPLY_QUOTE_SOURCE_INVALID`，对不存在、越权、错误角色、归档和顺序非法使用同一外部语义。
- [ ] 在持有 conversation 行锁并获得 next position 后，以来源公开 UUID 查询当前会话未归档消息；验证 role 与 position。
- [ ] 规范化 excerpt；不尝试把 sanitize 后 DOM 文本严格映射回 Markdown 原文。
- [ ] 返回内部来源行和不可变 excerpt，供消息写入和响应投影使用。

### 2.3 生成模型输入投影

修改：

- `app/services/conversations/service.py`
- `app/services/files/bindings.py` 只在需要澄清参数命名时做最小修改

实施：

- [ ] 新增纯函数，把 `reply_quote + content` 投影为明确分隔的模型文本。
- [ ] 对 excerpt 的边界标记进行转义或使用无歧义的结构化编码，避免引用文本伪造边界。
- [ ] 明确声明 excerpt 是用户控制的低信任引用数据，不获得 system/developer 优先级。
- [ ] `content` 非空时附加真实用户问题；`content` 为空时附加固定默认意图“解释这段引用内容”。
- [ ] 无回复引用时直接使用现有 `content`，确保普通消息 prompt 完全不变。
- [ ] 把模型文本而不是可见 `content` 传给 `prepare_attachment_plan()`；files 服务继续只产出 Text/Document/Image/Notice blocks，不认识 Reply Quote。
- [ ] `prepare_attachment_plan()` 使用模型文本进行非空输入和 token 预算判断，因此引用-only 成为有效模型输入。
- [ ] 消息 ORM 仍写真实 `content`，并同时写来源 internal id 与 excerpt。
- [ ] `append_transcript_message()` 保存 `AttachmentPlan.blocks`，从而固化模型实际收到的引用投影和附件快照。

### 2.4 接入路由

修改：

- `app/api/v1/conversations.py`

实施：

- [ ] 发送已有会话消息时把 `request.reply_quote` 传给会话服务。
- [ ] 新建会话路由保持无回复引用 contract。
- [ ] `resolve_provider_options()` 继续只接收 `request.content`，不让 excerpt 控制网页搜索偏好。
- [ ] 保持事务 commit 后才发布 `runs_queued`。

### 验证

```bash
uv run pytest -q \
  tests/api/test_conversations.py \
  tests/services/conversations/test_service.py \
  tests/services/runs \
  tests/worker/test_executor.py
uv run ruff check app tests
uv run mypy app
```

### 完成门

- API 可以安全创建引用-only Run。
- 数据库可见内容、结构化回复引用和 transcript 模型输入三者各自语义正确。
- 普通消息、附件消息、视觉输入和网页搜索相关既有测试全部通过。

---

## 阶段 3：编辑继承、重新生成与公开分享

### 3.1 先写生命周期测试

修改：

- `tests/services/conversations/test_regenerate.py`
- `tests/api/test_conversations.py`
- `tests/api/test_shares.py`
- `tests/services/shares/test_share_service.py`

新增失败用例：

- [ ] 编辑带引用用户消息时，修改提示文字但继承同一来源和 excerpt。
- [ ] 引用-only 消息可以保持空提示文字并编辑/重新发送。
- [ ] 无回复引用、无文字、无模型可消费附件的编辑仍被拒绝。
- [ ] 编辑请求不能提交替换或删除回复引用字段。
- [ ] 普通 regenerate 继续复用目标用户消息已有 transcript 输入。
- [ ] 来源 assistant 后续归档不会改写已发送引用 excerpt。
- [ ] 分享快照包含 excerpt，但不包含来源 internal/public id。
- [ ] 分享创建后来源或 live 消息变化不改写已冻结快照。
- [ ] quote-only 用户消息在公开响应中不是空白 turn。

### 3.2 编辑并重新生成

修改：

- `app/api/v1/conversations.py`
- `app/services/conversations/service.py`

实施：

- [ ] 编辑路由改用 `MessageEditAndRegenerateRequest`。
- [ ] 会话服务读取目标 user 消息现有回复引用，并在新修订消息上继承 internal source id + excerpt。
- [ ] 使用继承回复引用和新 content 重新生成模型输入投影与转写。
- [ ] 有继承引用时允许空 `new_content`；没有引用时继续要求文字或模型可消费附件。
- [ ] 现有附件继承、分支归档、脱离附件刷新、vision context 和 Run 创建顺序保持不变。

### 3.3 分享快照

修改：

- `app/services/shares/service.py`
- `app/schemas/shares.py`

实施：

- [ ] `_build_snapshot()` 对 user 消息冻结可选 `reply_quote: {excerpt}`。
- [ ] 匿名响应 schema 丢弃任何来源消息标识。
- [ ] 历史无字段快照继续按无回复引用读取。
- [ ] 不修改附件 ref、来源 citation、reasoning 隐藏或分享授权逻辑。

### 3.4 明确不改标题

- [ ] 不修改标题任务和 TitleAgent。回复引用要求同一会话中已有更早 assistant 消息，因此不可能成为首条用户消息；自动标题继续读取首个成功 Run 的首条用户输入。

### 验证

```bash
uv run pytest -q \
  tests/services/conversations/test_regenerate.py \
  tests/api/test_conversations.py \
  tests/api/test_shares.py \
  tests/services/shares/test_share_service.py
```

### 完成门

- 编辑、重新生成和分享都读取持久化快照，不从来源正文重新推导。
- 现有分支归档、附件继承和分享快照测试无回归。

---

## 阶段 4：前端 DTO、Composer 状态、草稿与提交链路

### 4.1 先写 reducer/store/API/hook 测试

修改：

- `frontend/src/app/store.test.ts`
- `frontend/src/conversations/submission.test.ts`（若当前不存在则新建）
- `frontend/src/conversations/useSendMessage.test.tsx`
- `frontend/src/conversations/useRegenerate.test.tsx`
- `frontend/src/api/conversations.test.ts`（按现有 API 测试位置补充）
- 新的 Reply Quote 草稿 store 测试

新增失败用例：

- [ ] Composer reducer 添加、替换、清除、恢复和 `app/reset` 回复引用。
- [ ] pending submission 保存回复引用。
- [ ] API 只在已有会话发送请求中发送 `reply_quote`。
- [ ] 引用-only 通过 `useSendMessage`，无输入仍被拒绝。
- [ ] 乐观提交包含回复引用。
- [ ] 发送失败恢复回复引用；快速重复调用不错误覆盖草稿。
- [ ] 编辑 hook 从目标消息判断是否有回复引用，允许 quote-only 编辑。
- [ ] 草稿按 user+conversation 隔离、清除其他用户、登出/认证失效 clearAll，并兼容损坏 localStorage。

### 4.2 DTO 与 API client

修改：

- `frontend/src/api/types.ts`
- `frontend/src/api/conversations.ts`
- `frontend/src/api/share.ts` 或相应公开分享 client 类型
- `frontend/src/test/apiFixtures.ts`

实施：

- [ ] 定义 `ReplyQuote`：可空 `source_message_id` + `excerpt`；发送草稿使用来源非空的窄类型。
- [ ] `MessageResponse`、`SharedMessage` 和发送响应 fixture 增加可选字段。
- [ ] `sendMessage()` 接受可选回复引用并写请求 body。
- [ ] `createWithMessage()` 不接受回复引用参数。
- [ ] `editAndRegenerate()` 不接受替换回复引用参数。

### 4.3 Composer reducer 与草稿 store

修改/新增：

- `frontend/src/app/store.ts`
- `frontend/src/conversations/replyQuoteDraftStore.ts`（新建）
- `frontend/src/conversations/replyQuoteDraftStore.test.ts`（新建）
- `frontend/src/auth/useAuthSession.ts`
- `frontend/src/app/authExpiry.ts`

实施：

- [ ] 扩展现有 composer slice，至少保存 `replyQuote: ReplyQuote | null`，新增 set/clear/restore action。
- [ ] 不把 Selection、Range 或 popover position 放进 reducer。
- [ ] 新 store 使用版本化 key `user + conversation`，只序列化来源公开 id 与 excerpt。
- [ ] source id、excerpt 形状非法时删除损坏草稿。
- [ ] logout、refresh 失败和身份切换同时清除附件草稿与回复引用草稿。
- [ ] 新会话 scope 永远不保存回复引用；切到 `/` 时清除当前 composer 回复引用。

### 4.4 pending submission 与发送编排

修改：

- `frontend/src/conversations/submission.ts`
- `frontend/src/conversations/useSendMessage.ts`
- `frontend/src/app/AppShell.tsx`

实施：

- [ ] pending state/action 增加回复引用快照。
- [ ] `useSendMessage` 参数增加可选回复引用；trim 只作用于用户 content，不改 excerpt。
- [ ] 目标会话为空而回复引用非空时在前端守卫失败，避免调用新会话 endpoint。
- [ ] AppShell `canSend` 把回复引用视为有效输入，同时保留附件 readiness、vision 和 Run 状态守卫。
- [ ] onSend 在清除 Composer 前捕获回复引用，传给 `send()`，并把它交给 optimistic pending message。
- [ ] 成功时清除该会话回复引用草稿；失败时仅在 Composer 当前没有更新引用时恢复原引用。
- [ ] 切换会话后加载对应草稿；detail 加载完成后，若来源 id 不在当前可见 final assistant 消息中，清除草稿并显示 `The quoted reply is no longer available.`。
- [ ] quote-only pending message `content=""`，但仍创建可见 user turn。

### 4.5 编辑 hook

修改：

- `frontend/src/conversations/useRegenerate.ts`
- `frontend/src/messages/Message.tsx` 的编辑保存守卫将在阶段 6 完成

实施：

- [ ] `editAndRegenerate()` 从当前 conversation detail 按 message id 查目标用户消息。
- [ ] 有回复引用时允许空 trimmed content；无引用时保持现有文字/附件守卫。
- [ ] 不把回复引用重新发送给 edit endpoint，后端负责不可变继承。

### 验证

```bash
cd frontend
pnpm exec vitest run \
  src/app/store.test.ts \
  src/conversations/replyQuoteDraftStore.test.ts \
  src/conversations/useSendMessage.test.tsx \
  src/conversations/useRegenerate.test.tsx
pnpm run typecheck
```

### 完成门

- 从 DTO 到 pending submission 的数据链闭合。
- 回复引用在成功、失败、重复调用、切换会话和身份 reset 中没有丢失或串用。
- 尚未实现 UI 时也能通过 reducer/hook 测试证明发送 contract 正确。

---

## 阶段 5：final assistant 文本选择与浮动“询问Piko”

### 5.1 先写应用级交互测试

修改：

- `frontend/src/app/AppShell.test.tsx`
- `frontend/src/messages/Message.test.tsx`
- 新增的选择 helper 私有测试仅覆盖 DOM 难以通过 AppShell表达的纯边界

新增失败用例：

- [ ] 在一条 final assistant Markdown 正文内创建 DOM Range 后出现“询问Piko”。
- [ ] 选区跨两条消息、位于 user 消息、ThinkingBlock、来源、附件、动作或 StreamingMessage 时不出现。
- [ ] 点击后 Composer state 获得来源 message id 和 `Selection.toString()` 的规范化文本。
- [ ] 已有回复引用时再次点击直接替换，按钮文案仍为“询问Piko”，无 toast/dialog。
- [ ] 点击后原生 Selection 清除并聚焦 Composer textbox。
- [ ] Escape、selection collapse、外部 pointer、thread scroll、resize 和 conversation change 关闭候选动作。
- [ ] 超过 4,000 字符时不修改已有引用，并显示明确错误 toast。

### 5.2 标记合法选择 surface

修改：

- `frontend/src/messages/Message.tsx`
- 必要时修改 `frontend/src/messages/markdown/CodeBlock.tsx`、`TableBlock.tsx` 等交互控件

实施：

- [ ] 只在 final assistant 的 Markdown 正文外壳增加稳定 `data-reply-quote-message-id` 标记。
- [ ] 标记不包围 ThinkingBlock、附件、SourcesTrigger 或消息动作。
- [ ] StreamingMessage 不提供该标记。
- [ ] 代码/表格复制、运行/预览等正文内控件设置不可选择或 exclude 标记，避免动作标签进入 excerpt；源码、表格单元格和链接可见文字仍可选择。
- [ ] 不修改 Markdown parser、sanitize 顺序或 React element 语义。

### 5.3 选择协调器与浮动按钮

新增/修改：

- `frontend/src/messages/useReplyQuoteSelection.ts`
- `frontend/src/messages/ReplyQuoteSelectionAction.tsx`
- `frontend/src/messages/MessageThread.tsx`
- `frontend/src/ui/icons.tsx`
- `frontend/src/styles/global.css` 或局部 Tailwind utility

实施：

- [ ] 监听 `selectionchange`，并在 pointerup/keyup 后从 Selection anchor/focus 找到合法正文根节点。
- [ ] 起点和终点必须属于同一个带 message id 的根节点；collapsed 或规范化后空文本不产生候选。
- [ ] 使用 `Selection.toString()` 获取浏览器实际可见文本；trim 首尾、CRLF→LF，保留内部空白。
- [ ] 捕获 Range 最后一个非零 client rect；保存候选 excerpt/message id/rect 到组件生命周期 state。
- [ ] 浮动按钮 portal 到 body，fixed 定位；上方空间不足时翻转下方并 clamp 到 viewport。
- [ ] `pointerdown` 阶段阻止 Selection 在 click handler 前丢失，但不阻断正文滚动或原生移动端选择。
- [ ] 点击回调 dispatch Composer 回复引用、持久化当前会话草稿、清除 Selection 并 focus textarea。
- [ ] 文案始终为“询问Piko”，只有单段按钮；复刻参考圆角、边框、阴影和排版。
- [ ] 视觉按钮保持参考尺寸，使用伪元素扩展到至少 44×44 命中区。
- [ ] Escape/外部 pointer/scroll/resize/navigation cleanup 必须成对解绑 listener。

### 验证

```bash
cd frontend
pnpm exec vitest run src/messages/Message.test.tsx src/app/AppShell.test.tsx
pnpm run lint
pnpm run typecheck
```

### 完成门

- final assistant 正文是唯一引用入口。
- 选择协调器不污染 Markdown seam、不吃掉 thread 滚动、不泄漏 document listener。
- jsdom 行为测试通过；定位精度留到阶段 7 的真实浏览器门。

---

## 阶段 6：Composer、用户消息、复制、编辑与分享 UI

### 6.1 先写组件/应用测试

修改：

- `frontend/src/ui/Composer.test.tsx`
- `frontend/src/messages/Message.test.tsx`
- `frontend/src/messages/SharePage.test.tsx`
- `frontend/src/app/AppShell.test.tsx`

新增失败用例：

- [ ] Composer 显示箭头、三行 excerpt 预览和“取消引用”按钮，不显示“引用 Piko”“引用内容”或默认解释提示。
- [ ] 引用与附件同时存在时顺序为：引用行、附件、输入区域。
- [ ] 关闭只移除引用并聚焦 textbox，文字和附件不变。
- [ ] 回复引用存在时 send 可用；移除后按其他输入重新计算。
- [ ] Message 带引用+文字时引用行在气泡上方；引用-only 时无气泡。
- [ ] Message 带附件时顺序为附件、引用、用户气泡，使回复引用紧邻用户输入。
- [ ] user message `content` 非空时复制 content；为空时复制 excerpt；桌面与移动 sheet 一致。
- [ ] 编辑面板展示不可变引用，没有关闭按钮；引用-only 允许保存。
- [ ] SharePage 使用相同发送后引用展示，没有 source id、编辑、复制或跳转动作。
- [ ] pending 与 server message 使用同一展示原语，React key 接管不造成引用闪空。

### 6.2 共用回复引用展示原语

新增：

- `frontend/src/messages/ReplyQuote.tsx`

实施：

- [ ] 提供私有的 `composer` 与 `message` 两种视觉模式；share 复用 `message` 模式。
- [ ] message 模式只渲染灰色箭头和 excerpt，不带背景/边框/标题。
- [ ] composer 模式增加右侧关闭动作与三行视觉 clamp，但不改 excerpt 数据。
- [ ] 使用语义 blockquote/可访问 region 与视觉箭头分离；不得让 screen reader 把关闭图标当引用文本。
- [ ] 样式优先使用 Tailwind utility 和现有 token；只有三行 clamp、参考伪元素或复杂选择浮层保留局部 CSS。

### 6.3 Composer 布局

修改：

- `frontend/src/ui/Composer.tsx`
- `frontend/src/app/AppShell.tsx`

实施：

- [ ] Composer props 增加可选回复引用和 `onRemoveReplyQuote`。
- [ ] 把回复引用与附件放进同一个 `col-span-3` prelude 行：引用在上、附件在下；现有 prompt/control row 仍维持 row 2/3 几何。
- [ ] 不因引用存在改变 send/stop 主按钮尺寸、模型 picker、工具菜单或 prompt-expanded footer 几何。
- [ ] 关闭后 requestAnimationFrame 聚焦 textarea。
- [ ] 引用进入/退出动画只改变 prelude 内容，不改变已经渲染的 streaming anchor geometry；reduced motion 下立即完成。

### 6.4 live Message 与编辑/复制

修改：

- `frontend/src/messages/Message.tsx`
- `frontend/src/messages/MessageThread.tsx`

实施：

- [ ] user turn 的 stack 顺序固定为：附件、回复引用、用户 content 气泡。
- [ ] quote-only 消息仍显示 action bar，并保持 user turn 的右对齐。
- [ ] 桌面 `handleCopy` 与移动 sheet 共用一个 copy source helper，避免规则漂移。
- [ ] 编辑状态在 textarea 上方展示不可变回复引用；不提供移除/替换。
- [ ] 保存守卫把 `message.reply_quote` 视为有效输入。
- [ ] assistant 消息现有 Markdown/Thinking/Sources/attachments/action 顺序不变。

### 6.5 SharePage

修改：

- `frontend/src/messages/SharePage.tsx`
- `frontend/src/api/types.ts`

实施：

- [ ] Shared user turn 在附件后、content 前使用同一 ReplyQuote message 模式。
- [ ] quote-only share turn 不为空白。
- [ ] 匿名 DTO 只有 excerpt；不创建来源跳转或读取私有消息的请求。

### 验证

```bash
cd frontend
pnpm exec vitest run \
  src/ui/Composer.test.tsx \
  src/messages/Message.test.tsx \
  src/messages/SharePage.test.tsx \
  src/messages/MessageThread.test.tsx \
  src/app/AppShell.test.tsx
pnpm run lint
pnpm run typecheck
pnpm run build
```

### 完成门

- 三种 UI 状态语义完整且与确认文案一致。
- quote-only 不产生空气泡或空白 share turn。
- 复制、编辑、关闭、发送和分享行为全部通过可访问交互测试。

---

## 阶段 7：真实 Chrome 严格视觉与 Selection 几何

### 7.1 扩展最高视觉 seam

修改：

- `frontend/tests/visual/thread-bottom.tsx`
- `frontend/tests/visual/thread-bottom.visual.ts`
- 必要时新增独立截图 baseline，但不创建生产 debug route

实施：

- [ ] fixture 增加一个短 final assistant 段落，内容与参考选区长度相近。
- [ ] fake `sendMessage` 接受并回显 reply quote，使同一 AppShell fixture 能走完选择→Composer→pending/server user message。
- [ ] Playwright 用 `document.createRange()` 建立真实选区，不通过直接设置 React state 绕过 Selection。
- [ ] 截取并核对三种状态：
  1. 选区高亮与单个“询问Piko”浮动按钮；
  2. Composer 顶部回复引用；
  3. 发送后灰色引用行 + 用户气泡。
- [ ] 桌面项目固定 `1440 × 900`，移动项目固定 `390 × 844`，浅色、DPR 1；记录浏览器版本、zoom 和平台。
- [ ] 将实际几何 JSON 作为 test artifact：选区 rect、按钮 rect、Composer rect、引用行 rect、用户气泡 rect、viewport/document scroll width。

### 7.2 浏览器行为断言

- [ ] 按钮优先在选区上方；把选区移近顶部后翻转到下方。
- [ ] 按钮左右不越出 viewport。
- [ ] 点击后 Selection collapsed、textbox focused、Composer 引用可见。
- [ ] thread scroll、window resize 和 Escape 关闭候选按钮。
- [ ] Composer 与 assistant 内容列继续左右对齐；引用 prelude 不产生页面水平 overflow。
- [ ] 移动端按钮有效命中区至少 44px，原生文本选择不被永久禁止。
- [ ] quote-only 与 quote+content 的用户 turn 均保持现有右侧 gutter。
- [ ] `prefers-reduced-motion: reduce` 下相关 transition duration 为 0。
- [ ] 现有 sticky Composer、底部 fade、136px 滚动到底部阈值与按钮 blur 断言继续通过。

### 7.3 严格视觉核对

- [ ] 浮动按钮只对参考图的“询问 ChatGPT”分段做 1:1 映射，文案替换为“询问Piko”，不保留“开始写作”分段。
- [ ] Composer 引用行逐项核对图标 path/尺寸、左边距、文字字号/颜色/行高、关闭按钮位置和上下间距。
- [ ] 发送后引用逐项核对箭头、灰色文本、与用户气泡的水平关系和垂直间距。
- [ ] 不为匹配参考截图修改已批准的 iChat 全局 canvas；记录这一宿主差异。
- [ ] 人工批准后再更新 desktop/mobile baseline；禁止用 mask 忽略回复引用区域。

### 验证

```bash
cd frontend
pnpm run test:visual
```

若只调试本场景：

```bash
pnpm exec playwright test tests/visual/thread-bottom.visual.ts --project=desktop
pnpm exec playwright test tests/visual/thread-bottom.visual.ts --project=mobile
```

### 完成门

- 三种参考状态在 desktop/mobile 真实 Chrome 中完成视觉批准。
- Selection、定位、焦点、滚动、overflow 和 reduced motion 均有数值证据。
- 现有 thread-bottom 浏览器行为无回归。

---

## 阶段 8：文档、全量验证与上线/回滚

### 8.1 文档同步

修改：

- `CONTEXT.md`：确认“用户消息”和“回复引用”定义与最终实现一致。
- `docs/architecture/frontend.md`：记录回复引用草稿、Selection 生命周期状态、Composer/pending/message/share 所有权。
- `docs/architecture/overview.md`：记录 messages 回复引用快照与 Run transcript 模型输入关系。
- `docs/handover/2026-08-31-reply-quote.md`：记录实现、迁移、视觉证据、验证、上线与回滚。
- `docs/README.md`：增加回复引用 handover 路由。
- `docs/specs/2026-08-31-reply-quote.md`：只在实现发现与冻结设计冲突时修正，并明确记录原因；不得静默改需求。

### 8.2 后端全量验证

```bash
uv run ruff check .
uv run mypy app
uv run alembic upgrade head
uv run pytest --tb=short -q
```

在一次性数据库补充：

```bash
uv run alembic downgrade 20260830_0020
uv run alembic upgrade head
```

### 8.3 前端全量验证

```bash
cd frontend
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
pnpm run test:visual
```

### 8.4 仓库检查

```bash
git diff --check
git status --short
```

确认：

- [ ] 没有 npm/yarn/bun lockfile；只有 `pnpm-lock.yaml`。
- [ ] 没有修改 SSE event contract、Provider Adapter 或 Markdown sanitize pipeline。
- [ ] 没有把临时剪贴板路径、Cookie、真实会话 URL 或登录态写入仓库。
- [ ] 没有覆盖与本功能无关的用户改动。

### 8.5 上线顺序

1. [ ] 备份数据库并部署 migration + API/Worker 兼容代码；`reply_quote` 全部可选，普通旧请求继续工作。
2. [ ] 在 API 环境执行普通消息、引用+提示、引用-only、非法跨会话来源和公开分享 smoke。
3. [ ] 部署前端创建入口与渲染支持。
4. [ ] 在真实桌面和移动 Chrome 执行划选→询问Piko→直接发送→带提示发送→复制→分享 smoke。
5. [ ] 观察 422/409、Run 创建失败和 share snapshot 错误率；确认没有 quote-only 空白 turn。

### 8.6 回滚规则

- [ ] 首选关闭/移除新的选择与发送入口，但保留 Message/SharePage 的回复引用读取与展示。
- [ ] 生产已经存在 quote-only 消息后，不得直接回滚到完全不认识 `reply_quote` 的旧前端，否则历史会出现空白 user turn。
- [ ] API 可回滚到“不再接受新引用但仍返回已有引用”的兼容版本；不要先删除响应字段。
- [ ] 只有确认生产没有回复引用数据，或已完成数据处置后，才能 downgrade 删除数据库列。
- [ ] 回滚不改写已有 excerpt，不把 excerpt 填入 `messages.content` 伪装成用户输入。

### 最终完成门

以下条件全部满足后，将本计划状态更新为“已完成”：

- [ ] 规格中的全部可观察用户故事均有实现或明确测试覆盖。
- [ ] API、数据库、转写、编辑、重新生成、草稿、乐观提交和分享闭环通过。
- [ ] 三张 UI 参考在 desktop/mobile 真实 Chrome 中批准。
- [ ] 后端 Ruff、mypy、迁移和全量 pytest 通过。
- [ ] 前端 lint、typecheck、全量 Vitest、build 和 Playwright 通过。
- [ ] `git diff --check` 通过，handover 与架构文档同步完成。

## 推荐提交拆分

为便于审查和回滚，按以下 Conventional Commits 拆分，不把无关格式化混入：

1. `feat(conversations): persist reply quotes and expose api contract`
2. `feat(runs): include reply quotes in model input transcripts`
3. `feat(shares): preserve reply quotes in snapshots`
4. `feat(frontend): add reply quote draft and submission state`
5. `feat(messages): add assistant text selection quote action`
6. `feat(composer): render and send reply quotes`
7. `test(frontend): add reply quote browser visual coverage`
8. `docs(chat): document reply quote lifecycle and rollout`
