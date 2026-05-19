# 草稿对话与自动标题生成 设计

日期：2026-05-19

## 目标

把"新建对话"的语义从"立刻持久化、立刻可见"改为"草稿态、首次 AI 成功回复后才公开可见，并附带自动生成的标题"。两件事在 worker 端的同一事务里完成，对用户表现为一个原子动作。

具体地：

1. **草稿态对话**：用户点击"新建"后创建的 conversation 行不立刻出现在侧边栏列表中；当且仅当该 conversation 内首次出现 `run.status = succeeded` 时，被"激活"为可见。后续生命周期内不会再回到隐藏态。
2. **自动标题生成**：当一条 conversation 首次激活时，如果其 `title IS NULL`，worker 用 LLM 基于"用户首条消息 + assistant 首条回复"生成一个不超过 32 字符的简短标题，跟随用户消息语言。标题生成失败不影响激活、不影响主对话流。

## 行为

### 草稿态与激活

新增列 `conversations.activated_at TIMESTAMPTZ NULL`，语义为"首次 AI 成功回复完成的时刻"。

- **创建**（`POST /api/v1/conversations`）：保持现状，`activated_at` 默认 `NULL`。
- **列表**（`GET /api/v1/conversations`）：过滤 `deleted_at IS NULL AND activated_at IS NOT NULL`。草稿对用户不可见。
- **明细**（`GET /api/v1/conversations/{id}`）：保持现状，**不**加 `activated_at` 过滤——owner 仍允许打开自己的草稿（用于刷新恢复、流式接管）。
- **rename**（`PATCH /api/v1/conversations/{id}`）：保持现状，**不**触发激活。用户在草稿态重命名后，对话仍隐藏，直到首次 AI 成功回复。
- **delete**（`DELETE /api/v1/conversations/{id}`）：保持现状，软删除 + `updated_at` 刷新，不区分草稿/激活。
- **发消息 / edit-and-regenerate / regenerate**：保持现状，不要求 conversation 已激活；草稿期间允许跑 run。
- **激活时机**：在 `materialize_assistant_message` 内、与 `mark_run_succeeded` 同一事务，执行：

  ```sql
  UPDATE conversations
    SET activated_at = now(), updated_at = now()
    WHERE id = :conversation_id AND activated_at IS NULL;
  ```

  幂等：edit-and-regenerate 等后续 run 命中 `activated_at IS NOT NULL` 而不做事。

- **激活后**不再回到草稿态。即使首次 run 之后所有消息被归档、所有后续 run 失败，对话仍保持可见（与"用户已经看过它"的事实一致）。

### 自动标题生成

- **触发条件**（worker 端，commit 完成激活事务**之后**）：
  - `materialize_assistant_message` 返回的 message 不为空；
  - 该 run 是 conversation 的**首个**已成功 run（判定：该 conversation 上 `runs.status='succeeded'` 的行只有当前这一行，即 `count = 1`）；
  - conversation `title IS NULL`；
  - 配置 `auto_title_enabled = True`。
- **输入**：
  - user 首条消息：取 `messages` 中 `archived_at IS NULL` 且 `role='user'` 且 `position` 最小的那一条 content。
  - assistant 首条回复：即刚刚 materialize 的 message 的 content。
- **LLM 调用**：通过 `Provider.summarize()` 非流式接口（见下）。System prompt 中文写明：
  - 输出语言**跟随用户消息**（不显式判定，让模型自适配）；
  - 只输出标题文本，不带引号、不带标点结尾、不带"标题："前缀；
  - 长度限制提示（"不超过 16 个汉字或 32 个英文字符"）。
  - few-shot 略，以系统提示精炼描述代替。
- **后处理**：
  - `strip()`、去掉成对引号 / 反引号 / 中文书名号、合并连续空白；
  - 截断到 `auto_title_max_chars`（默认 32）字符（按 unicode codepoint 计）；
  - 若 strip 后为空字符串，视为生成失败。
- **写回**：

  ```sql
  UPDATE conversations
    SET title = :title, updated_at = now()
    WHERE id = :conversation_id AND title IS NULL;
  ```

  仅在 `title IS NULL` 时写入，避免覆盖用户手动重命名。

- **失败处理**：捕获 `ProviderError` / `asyncio.TimeoutError` / 任何异常，仅记日志 `bind(conversation_id, run_id, code, message).warning(...)`，title 保持 NULL。不重试。下一次符合"首个 succeeded run"的条件不会再出现（除非用户自己删了 assistant 消息再 regenerate，但那时这条对话已激活、已可见，title 缺失也只是显示"新对话"的小瑕疵）。
- **超时**：`summarize()` 内部 `httpx.Timeout(15.0, connect=5.0)`，比主对话 60s 更紧。失败即放弃。

### 取消语义

- 主对话 run 被 cancel / fail → 不会进入激活分支（`mark_run_succeeded` 没成功）→ conversation 仍是草稿、用户依然看不到它。这是期望行为。
- 用户在主对话 streaming 时取消，原 run 转为 cancelled，conversation 仍未激活。若紧接着用户在同一草稿里发送新消息成功，由新 run 激活。

## 数据模型

### `conversations` 表新增

- `activated_at TIMESTAMPTZ NULL`，无 server_default、无 server_onupdate。
- 既有索引 `ix_conversations_user_deleted_updated` 不动；列表查询会在已过滤的小集上再 `WHERE activated_at IS NOT NULL`，扫描量可忽略。

### 既有数据迁移

新列加上之后，**回填**所有现存对话 `activated_at = COALESCE(activated_at, created_at)`：

```sql
UPDATE conversations SET activated_at = created_at WHERE activated_at IS NULL;
```

保证旧数据在新过滤条件下仍然可见。Alembic 迁移在 `op.add_column(...)` 之后用 `op.execute(...)` 完成。

## API & Schema

### 列表过滤

`list_conversations(session, user=)` 在 `select(Conversation).where(...)` 中追加：

```python
Conversation.activated_at.is_not(None),
```

### Response schema

`ConversationResponse` 新增字段 `activated_at: datetime | None`：

- 列表接口返回的 conversation 都已激活，此字段非空。
- 明细接口（草稿也可获取）允许字段为 `None`。

前端用此字段判定"当前打开的会话是否仍为草稿"。

### 不需要新接口

激活与标题生成都在 worker 内部完成，对外无需新 endpoint。前端通过 SSE 拿到 `run_succeeded` 后**主动**重拉 `GET /conversations`，会看到新出现的对话和标题；同时主区域已加载的 detail 也可重拉一次以更新 `title`。

## Provider 抽象

`app/providers/types.py` 新增：

```python
class Provider(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]: ...

    @abstractmethod
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str: ...
```

`DeepSeekProvider.summarize` 实现：

- 端点 `/chat/completions`，`stream=False`，`"thinking": {"type": "disabled"}`。
- 请求体加上 `max_tokens=max_output_tokens`（默认配置传 40）、`temperature=0.3`。
- 超时 `httpx.Timeout(15.0, connect=5.0)`，独立于流式请求。
- 4xx/5xx 抛 `ProviderError(code="deepseek_summarize_http_error" | "deepseek_summarize_transport_error")`。
- 返回 `response.json()["choices"][0]["message"]["content"]`；缺失/空抛 `ProviderError(code="deepseek_summarize_empty")`。
- **不**复用流式解析路径；专门一段简短的非流式 JSON 解析。

`tests/providers/fake.py` 的 `FakeProvider` 需要同步实现 `summarize`：构造时可选 `summarize_result: str | ProviderError`，调用即返回/抛出；默认值 `"Fake Title"`，便于既有测试无感知通过。

## 配置

`app/core/config.py` 新增字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `auto_title_enabled` | `bool` | `True` | 总开关；关掉后 worker 跳过整段 |
| `summary_provider_name` | `str` | `"deepseek"` | 走 `resolve_provider` 解析；当前只有 deepseek |
| `summary_model` | `str` | （必填）| 标题生成用的模型 id，与 `deepseek_model` 独立配置 |
| `auto_title_max_chars` | `int` | `32` | 后处理硬截断长度 |
| `auto_title_max_output_tokens` | `int` | `40` | 传给 provider 的 `max_tokens` |

`.env.example` 同步加上这些键，`summary_model` 默认填 `deepseek-chat` 之类（与 `DEEPSEEK_MODEL` 区分），让用户清楚这是一个独立配置点。

## Worker 集成

`app/worker/executor.py` 的 `_run_provider_stream` 在 `Finish` 分支当前已经在同一个事务内完成：

1. flush pending；
2. `mark_run_succeeded`；
3. `materialize_assistant_message`；
4. commit。

**改动**：把"激活"塞进同一事务，把"标题生成"作为 commit 之后的 best-effort 段。

### A. 激活（与 succeed 原子）

`app/services/conversations/service.py` 新增辅助函数 `ensure_conversation_activated(session, conversation_id)`：

```python
async def ensure_conversation_activated(session, *, conversation_id: int) -> None:
    await session.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id, Conversation.activated_at.is_(None))
        .values(activated_at=func.now())
    )
```

由 `materialize_assistant_message` 在 `conversation.updated_at = ...` 之前调用一次。语义清晰：首条 assistant 物化 = conversation 激活；同事务原子；幂等。executor 端**无需**新增任何调用。

### B. 标题生成（commit 后 best-effort）

executor 在 `Finish` 分支 commit 完成之后，调用新函数：

```python
await maybe_generate_title(
    session_factory=session_factory,
    run_id=run_id,
    settings=settings,
    resolve_provider=resolve_provider,
)
```

`maybe_generate_title` 用 try/except 包住，任何异常仅日志（含 `run_id`、`conversation_id`、`code`、`message`）。流程：

1. 如果 `settings.auto_title_enabled is False` → 立刻返回；
2. 新开一个 session 读：conversation（确认 `title IS NULL` 且 `deleted_at IS NULL`）+ count succeeded runs in this conversation（必须 = 1）+ 该 conversation 内 `archived_at IS NULL` 且 `role='user'` 且 position 最小的 user message + 本 run 刚物化的 assistant message。任一不满足返回；
3. `resolve_provider(settings.summary_provider_name, settings=settings).summarize(...)`；
4. 后处理（见"自动标题生成"段）；空字符串返回；
5. 新开 session，`UPDATE conversations SET title=:t, updated_at=now() WHERE id=:id AND title IS NULL`，commit。

读和写分两次小事务即可——这是一段非关键路径，无需 `for update`。

## 前端

### 1. "新建"不再立刻进侧边栏

`createEmptyConversation()`：

```js
const conv = await withAuth((t) => api.conversations.create(t, null));
setState({
  // ⚠ 不再把 conv 加进 conversations 列表
  selectedId: conv.id,
  detail: { ...conv, messages: [] },
  draftConversationId: conv.id,   // 新增
});
return conv;
```

新增 state 字段 `draftConversationId`：

- 取值 `number | null`；
- 与 `selectedId` 通常一致，但侧边栏渲染逻辑用它来判断"这个 selectedId 是不是当前未入列表的草稿"，避免误判"selectedId 没在 conversations 中 → 选中失效"。

### 2. localStorage 持久化 selectedId（场景 4）

新增 `frontend/state.js` 中关心两个键的持久化策略（其他 state 不持久化）：

- `localStorage.setItem("ichat.selectedId", id)` 在 `setState({selectedId})` 后；
- `localStorage.setItem("ichat.draftConversationId", id)` 同理。

`renderChatView` 启动时：

```js
const persistedSelected = Number(localStorage.getItem("ichat.selectedId")) || null;
const persistedDraft = Number(localStorage.getItem("ichat.draftConversationId")) || null;
if (persistedSelected) {
  setState({ selectedId: persistedSelected, draftConversationId: persistedDraft });
  void selectConversation(persistedSelected);  // 走既有 maybeResumeRun 路径恢复 SSE
}
```

`selectConversation` 内部已经调 `GET /conversations/{id}`（草稿也允许）+ `maybeResumeRun`，自然能续上 streaming。

登出 / `deleteConversation` 当前对话时，清掉两个 key。

### 3. Run 成功后刷新列表

`frontend/sse.js`（或 `chat.js` 内的 `attachRunStream` 终止回调，已存在）在收到 `run_succeeded` 时：

- 调 `loadConversations()` 重拉列表 — 草稿激活后会出现，已激活的对话顺序刷新（`updated_at` 也变了）。
- 若当前 detail.id === draftConversationId，再调 `api.conversations.detail(t, id)` 重拉 detail（拿到自动生成的 title）；并清空 `draftConversationId`。

### 4. 侧边栏渲染微调

`rerenderSidebar` 当前以 `c.id === selectedId` 高亮选中行。草稿不在 conversations 中，所以选中草稿时侧边栏没有高亮——可以接受，因为草稿就是"未上架"。无需为草稿单独渲染一个临时占位行（产品意图就是"完全不出现"）。

### 5. 标题占位与显示

- `conversationRow`、`rerenderMain` 的 `detail.title?.trim() || "新对话"` 占位逻辑保留。草稿和 title 生成失败时都显示"新对话"。
- 不显式提示"标题为自动生成"。

### 6. rename 草稿

`renameConversation` 路径不变。后端 `PATCH` 允许，不激活。前端在草稿态 rename 之后：

- conversations 列表里还是没有这条（仍未激活）；
- `detail.title` 更新；
- 用户刷新会发现"刚改的标题不在了"——这是已知 trade-off，已在场景表里告知。**不在 UI 上特别警示**，保留简洁。

## 错误码 / 兼容

- 新增列对既有 API response 是字段追加，不破坏前端。
- 不引入新错误码。
- 标题生成失败仅日志、不进 SSE、不写 `run_events`。

## 验证

### Service / Worker 测试（pytest，挂真 Postgres）

- **列表过滤**：创建两个会话，其中一个 `activated_at IS NULL`，`list_conversations` 仅返回另一个。
- **明细对草稿**：草稿仍能 `get_conversation_detail`；越权（他人的草稿）返回 404（既有逻辑兜底）。
- **激活幂等**：直接两次调用 `ensure_conversation_activated` 同一 conversation，第二次 `activated_at` 不变。
- **首次 succeeded 激活**：通过 fake provider 跑完一个 run，assistant 物化后 `activated_at` 非空，再跑一个 edit-and-regenerate run，`activated_at` 不变。
- **取消不激活**：跑一个 run 在 streaming 中调 cancel → 取消落地 → `activated_at` 仍为 NULL。
- **标题生成成功**：fake provider 的 `summarize` 返回固定字符串，验证 `title` 落库为后处理结果；同时验证 SQL 仅命中 `title IS NULL`（先手动 set title，再调，title 不被覆盖）。
- **标题生成失败不影响激活**：fake provider 的 `summarize` 抛 `ProviderError`，`activated_at` 仍写入、`title` 仍为 NULL，不 raise。
- **后处理**：fake 输出含引号 / 换行 / 超长 / "标题："前缀 / 仅空白，分别验证最终落库结果。
- **多 succeeded run 不重复生成**：第一次成功后手动把 title 改回 NULL，再跑一次 edit-and-regenerate，因为 `count(succeeded)=2`，不再生成。

### Provider 单测

`DeepSeekProvider.summarize` 用 `httpx.MockTransport`：

- 2xx + 正常 body → 返回字符串。
- 2xx + 空 content → `ProviderError(code="deepseek_summarize_empty")`。
- 4xx → `ProviderError(code="deepseek_summarize_http_error")`。
- transport 异常 → `ProviderError(code="deepseek_summarize_transport_error")`。
- 验证请求体 `stream=False`、`thinking.type=disabled`、`max_tokens` 传值。

### API 集成测试

- `POST /conversations` 返回 `activated_at=None`，但该 id 不出现在随后的 `GET /conversations`。
- 跑完一条消息的完整链路（用 fake provider），`GET /conversations` 包含此 id 且 `title` 非空。
- 草稿状态下 `PATCH /conversations/{id}` 改 title 成功，但仍不出现在列表里。

### 前端手动 smoke

- 全新登录用户点"新建"→ 输入消息 → AI 回完 → 侧边栏冒出一条新对话且标题为自动结果 ✓。
- 输入消息发送 → AI 流式过程中按 F5 → 主区域恢复继续流（依赖 localStorage） → AI 回完 → 侧边栏出现 ✓。
- 点"新建"什么都不发 → 刷新 → 侧边栏依然无此条目 ✓；主区域因 `localStorage` 中的 `selectedId` 而恢复该草稿的空对话视图（用户可以继续在里面发消息），无副作用。
- 草稿态双击标题改名 → 仍不进侧边栏 ✓。
- 配置 `auto_title_enabled=False` → 走通流程 → conversation 激活但 title 保持 NULL，侧边栏显示"新对话" ✓。

## 可见性场景矩阵

| 场景 | 刷新后侧边栏可见？ | 备注 |
|---|---|---|
| 点"新建"什么都不做 | ❌ | conversation 行存在但 `activated_at IS NULL` |
| 点"新建"，输入未发送 | ❌ | 同上 |
| 点"新建"，重命名草稿（未发消息） | ❌ | rename 不激活，刷新后用户看不到自己设的标题 |
| 点"新建"，发送，run queued/streaming 时刷新 | ❌ 当下；run succeed 后下次 list 拉取自动出现 | 依赖 localStorage 让主区域续上流式 |
| 点"新建"，发送，run 失败 / 被取消 | ❌ | 永久草稿 |
| 点"新建"，发送，run 成功 | ✅ | 带自动标题（失败则显示"新对话"） |
| 已激活历史对话 | ✅ | 与现状一致 |

## 实现边界

- **不**做草稿 GC（孤儿草稿留给后续迭代；可以加一个 sweep job 删除 `activated_at IS NULL AND created_at < now() - interval '7 days' AND deleted_at IS NULL` 的草稿，但本期不做）。
- **不**做 SSE 端的 `title_updated` 事件——前端在 `run_succeeded` 时主动重拉就够，避免给 SSE 增加新 event type。
- **不**重试标题生成。失败=放弃，下次没有"首次 succeeded"窗口了。
- **不**改 `run_events` 类型；标题生成不写 events 表。
- **不**重命名 / 删除既有列；只追加 `activated_at`。

## 关联文档

- 架构总览：[`../../architecture/overview.md`](../../architecture/overview.md)
- 模块边界：[`../../architecture/module-boundaries.md`](../../architecture/module-boundaries.md)
- Conversation 模块实现：[`../../handover/2026-05-17-conversation-module.md`](../../handover/2026-05-17-conversation-module.md)
- Provider & worker：[`../../handover/2026-05-17-provider-and-worker.md`](../../handover/2026-05-17-provider-and-worker.md)
