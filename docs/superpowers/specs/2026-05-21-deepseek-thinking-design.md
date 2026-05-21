# DeepSeek 思考模式（thinking）设计

日期：2026-05-21

> 本文取代并扩展了同日的窄版草案 `2026-05-21-deepseek-reasoning-effort-design.md`（仅设计 `reasoning_effort` 发送）。本次将思考模式做成端到端能力：发送思考强度参数、持久化思维链增量、配合重放机制、前端实时与历史展示。

## 目标

在 DeepSeek 流式调用中完整支持思考模式：

1. **发送参数**：在思考模式开启时随请求发送 `reasoning_effort`（思考强度），与已有的 `thinking.type` 开关配合。
2. **持久化思维链**：把模型输出的思维链增量（`reasoning_content`）作为独立的 run event 持久化，与现有重放机制对齐——用户中途断线重连时能看到已经生成的思考过程。
3. **前端实时展示**：流式生成思考时在前端实时展示；正式回答开始/完成后自动收起；历史消息中同样可点开查看。

## 背景

### DeepSeek 文档要点（见 `deepseek_thinking.md`）

- 思考模式开关由 `{"thinking": {"type": "enabled/disabled"}}` 控制（项目已实现），默认 `enabled`。
- 思考强度由 `reasoning_effort` 控制，取值 `high` / `max`；为兼容，`low`、`medium` 服务端映射为 `high`，`xhigh` 映射为 `max`。普通请求思考模式下默认 effort 为 `high`。
- 思维链通过与 `content` **同级**的 `reasoning_content` 字段返回（流式下为 `delta.reasoning_content`）。
- **未发生工具调用的轮次**，上一轮的 `reasoning_content` 不需要、也不会被拼接进后续上下文（传入也会被忽略）。本项目当前不涉及工具调用，因此思维链只用于展示与历史，绝不回传进 prompt。

### 当前架构现状（已核对）

- **Provider**：`DeepSeekProvider.stream()` 产出 `TextDelta | Finish`；`deepseek_parser.parse_sse_line` 只解析 `delta.content`。`deepseek_thinking_enabled` 已经控制 `thinking.type`，但尚未发送 `reasoning_effort`。
- **Worker**（`app/worker/executor.py`）：把 `TextDelta` 按时间窗口 + 字符数批处理，落成 `text_delta` run event；首次 flush 调用 `mark_run_streaming`（`started → streaming`）。出错时存在「首个增量之前可重试一次」的逻辑。
- **持久化 / 重放**：`run_events` 永久保留（成功后不删除）。`append_run_event` 为每条事件分配自增 `seq` 并 `pg_notify`。SSE 端点 `GET /runs/{id}/events` 用 `list_run_events_after` 通用地转发**任意**事件类型（`event: {type}`）；`GET /runs/{id}/state` 用 `text_delta` 事件重建 `draft_text` 供断线重连。
- **约束**：`RunEvent.type` 同时受数据库 CHECK 约束与 Pydantic `Literal` 限制，新增事件类型需迁移 + schema 改动。
- **物化**：run 成功（`Finish`）时 `materialize_assistant_message` 把全文写入 `messages.content`；`messages` 表当前只存最终回答。
- **上下文**：`app/context/builder.py` 用 `ProviderMessage(role, content=row.content)` 组装，只读 `content`——思维链天然不会进入 prompt。

## 已确认的设计决策

| 决策点 | 选择 |
|--------|------|
| 思维链历史可见性 | **永久附在消息上**：`messages` 新增 `reasoning` 列，刷新页面/重开旧对话仍可查看。 |
| `reasoning_effort` 配置粒度 | **全局环境变量**，与 `deepseek_thinking_enabled` 同级。 |
| 前端展示方式 | **可折叠面板**：生成中展开并实时滚动，正式回答开始/完成后自动收起；历史消息默认收起、可点开。 |

### 关键架构选择：并行的 `reasoning_delta` run event

思维链增量作为**独立的事件类型** `reasoning_delta` 持久化，与 `text_delta` 完全平行地批处理。重放 / SSE / `/state` 已经按事件通用处理，断线重连重放思维链「自动可用」。run 成功物化时，把累计的完整思维链**同时**写入 `messages.reasoning` 作为永久历史。

被否定的替代方案：

- **只在 finish 时存最终思维链**：无法满足需求 2（重连时在思考完成前看不到任何内容）。
- **复用 `text_delta`、payload 里加 channel 标记**：污染已稳定的事件类型，使 `/state` 的 draft 组装与前端都更复杂。

## 详细设计

### 1. 配置（`app/core/config.py`、`.env.example`）

- 新增 `deepseek_reasoning_effort: str = "high"`。
- 增加 `field_validator`：规范化为小写，只接受 `{low, medium, high, xhigh, max}`，非法值（拼写错误等）在加载配置时即抛错。沿用 `log_level` 的校验器风格。
- 该项可选（带默认值）：不加入必填 `ENV_KEYS`、不要求 CI 注入；仅在 `.env.example` 思考开关下方记录 `DEEPSEEK_REASONING_EFFORT=high` 作为文档。

### 2. Provider（`app/providers/`）

- `types.py`：新增 `@dataclass(frozen=True) ReasoningDelta(text: str)`；`ProviderChunk = TextDelta | ReasoningDelta | Finish`。
- `deepseek_parser.py`：在解析 `delta` 时，`delta.reasoning_content`（非空字符串）→ `ReasoningDelta`；`delta.content` 维持 → `TextDelta`。`finish_reason` 优先级不变。
- `deepseek.py::stream()`：当 `deepseek_thinking_enabled` 为真时，向请求 payload 注入 `"reasoning_effort": <配置值>`（与已有 `thinking.type` 并列）；关闭思考时不发送该字段。
- `summarize()` 不受影响：始终关闭思考，不发送 `reasoning_effort`（自动标题等沿用）。

### 3. 持久化与重放

#### 3.1 数据模型与迁移

- `RunEvent.type` 的 CHECK 约束新增 `'reasoning_delta'`；`app/schemas/runs.py` 的 `RunEventType` Literal 同步新增。**Alembic 迁移**修改该约束（`drop` 旧约束、`create` 含新值的约束）。
- `messages` 新增可空列 `reasoning: Text`（**Alembic 迁移**）；对应 ORM `Message.reasoning: Mapped[str | None]`。

#### 3.2 Worker 批处理（`app/worker/executor.py`）

- 把现有单一 `pending` 缓冲泛化为「带 channel 的缓冲」：维护 `current_channel ∈ {"reasoning", "text"}`。
- DeepSeek 先输出 reasoning、再输出 content。当到来的 chunk 与 `current_channel` 不同（channel 切换）时，先把当前缓冲按对应事件类型 flush，再切换 channel 并开始缓冲新 channel。channel 内部仍按 `worker_delta_batch_window_ms` / `worker_delta_batch_max_chars` 批处理。
- flush 落事件时按 channel 决定 `event_type`：`reasoning` → `reasoning_delta`，`text` → `text_delta`。
- **首次 flush（任意 channel）**调用 `mark_run_streaming`（思考即视为「生成已开始」）。
- 累计完整思维链 `reasoning_parts`；在 `Finish` 分支把它传给 `materialize_assistant_message(reasoning=...)`。
- **重试去重副作用**：因为首次 reasoning flush 已置 `first_flush_done=True`（即 `before_first_delta=False`），现有「首个增量之前可重试一次」的逻辑在思考开始后不再触发，思维链不会在重放中被重复写入。`run_has_text_delta` 维持只查 `text_delta`，仅服务于取消/失败时 `delta_persisted` 的判断，无需改动。

#### 3.3 物化（`app/services/conversations/service.py`）

- `materialize_assistant_message` 增加 `reasoning: str | None = None` 形参，写入 `Message.reasoning`。
- 取消 / 失败的 run **不物化** assistant message——此时部分思维链只存在于 `run_events`，与现有「部分正文不物化」完全对称，不做特殊处理。

#### 3.4 状态快照（`app/services/runs/service.py`、`app/schemas/runs.py`）

- `get_owned_run_state` 在遍历事件时，额外用 `reasoning_delta` 事件累计 `draft_reasoning`（与 `draft_text` 平行）。
- `RunStateResponse` 新增 `draft_reasoning: str`（默认空串），供前端断线重连时回填思考面板。
- SSE 端点 `format_sse_event` / `list_run_events_after` 通用转发，无需改动——`reasoning_delta` 会以 `event: reasoning_delta` 自动下发。

### 4. 前端（`frontend/`）

- `sse.js`：已通用解析任意事件类型，**无需改动**（`reasoning_delta` 会以 `{ type, payload:{text} }` 到达）。
- `chat.js`：
  - `renderMessage` 渲染：assistant 消息若 `reasoning` 非空，渲染同一套可折叠「思考过程」面板，历史默认收起、可点开。
  - 占位消息（placeholder）与 `updateAssistant*` 增加 `reasoning` 字段。
  - `attachRunStream` 的 `onEvent` 新增分支：`reasoning_delta` → 追加到 `reasoningDraft`，写入 assistant 气泡上方的「思考过程」面板，生成中默认展开并随内容自动滚动；收到首个 `text_delta`（或终止事件）时自动收起。
  - `maybeResumeRun` / 重连：从 `GET /state` 的 `draft_reasoning` 回填思考面板初始内容。
  - run 成功后 `attachRunStream` 会重新拉取 `conversations.detail`；`MessageResponse.reasoning` 据此渲染历史面板（默认收起）。

## 端到端数据流

1. **正常生成**：worker 收到 `ReasoningDelta`…（批处理）→ `reasoning_delta` 事件；channel 切到 text 后 `TextDelta` → `text_delta` 事件；`Finish` → `mark_run_succeeded` + `materialize_assistant_message(content, reasoning)` + `run_succeeded` 事件。前端实时展开思考面板，正文开始时收起。
2. **中途重连**：客户端 `GET /state` 拿到 `draft_reasoning` + `draft_text` 回填，再 `GET /events?after_seq=…` 续播后续 `reasoning_delta` / `text_delta`，思考过程无缝衔接。
3. **历史浏览**：`conversations.detail` 返回带 `reasoning` 的 assistant 消息，前端渲染可点开的思考面板。

## 边界情况

- **取消 / 失败**：不物化 message，部分思维链仅留在 `run_events`（与部分正文一致）。当前会话内已展示的思考保留；该 run 无 assistant message 时，重连依赖 `/state` 重放。
- **重试**：思考开始后不再重试，避免思维链重复（见 3.2）。
- **多轮上下文**：思维链绝不进入 prompt——`build_context` 只读 `content`，符合 DeepSeek 语义。

## 非目标

- 不支持工具调用（thinking + tool_calls 的 `reasoning_content` 回传规则）。
- 不做按对话 / 按请求的 effort 控制（全局环境变量即可）。
- 不改动自动标题：`summarize()` 始终关闭思考。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `app/core/config.py` | 新增 `deepseek_reasoning_effort` 字段与校验器 |
| `.env.example` | 新增 `DEEPSEEK_REASONING_EFFORT=high` |
| `app/providers/types.py` | 新增 `ReasoningDelta`，扩展 `ProviderChunk` |
| `app/providers/deepseek_parser.py` | 解析 `delta.reasoning_content` |
| `app/providers/deepseek.py` | `stream()` 条件注入 `reasoning_effort` |
| `app/models/run.py` | `RunEvent.type` CHECK 约束加 `reasoning_delta` |
| `app/models/conversation.py` | `Message.reasoning` 可空列 |
| `app/schemas/runs.py` | `RunEventType` 加 `reasoning_delta`；`RunStateResponse.draft_reasoning` |
| `app/schemas/conversations.py` | `MessageResponse.reasoning` |
| `app/services/runs/service.py` | `get_owned_run_state` 累计 `draft_reasoning` |
| `app/worker/executor.py` | channel 化批处理，累计 reasoning，物化时传入 |
| `app/services/conversations/service.py` | `materialize_assistant_message` 增加 `reasoning` 形参 |
| `alembic/versions/*` | 两处迁移：run_events CHECK 约束、messages 新列 |
| `frontend/views/chat.js` | 思考面板渲染 + `reasoning_delta` 流式处理 + 重连回填 |

## 测试与验证

- **配置测试**：环境变量解析、直接构造、`.env.example` 形状一致、非法取值被拒、大小写规范化。
- **parser 测试**：`delta.reasoning_content` → `ReasoningDelta`；`delta.content` → `TextDelta`；finish 不变。
- **provider 测试**：思考开启时 payload 含 `reasoning_effort` 且取自配置；关闭时不含。
- **worker 测试**：reasoning→text channel 切换正确 flush 出 `reasoning_delta` 后 `text_delta`；首个 reasoning flush 触发 `mark_run_streaming`；成功时 `messages.reasoning` 被写入；思考开始后不重试。
- **state / replay 测试**：`/state` 返回 `draft_reasoning`；SSE 下发 `reasoning_delta`。
- **前端测试**：`chat.test.js` 覆盖 `reasoning_delta` 累积、自动收起、历史面板渲染。
- **回归命令**：`pytest`、`ruff check app tests`、`mypy app`；迁移 up/down；手动验证三条数据流（实时思考、中途重连重放、重开旧对话）。
