# Regenerate 设计

日期：2026-05-19

## 目标

为聊天功能新增两个交互入口：

1. **Edit-and-regenerate**：用户在自己的某条 user message 上点"编辑"，改写文本后提交，会话从该点之后整体重新生成。
2. **Regenerate-only**：用户在某条 assistant message 上点"重新生成"，沿用其对应的 user 文本，仅替换其后的 assistant 回复（及任何后续消息）。

两条入口共用同一套后端语义：以一条 user message 为锚点，将其后（按 position 排序）的所有未归档消息归档，再创建一个新 run 触发流式生成。会话呈线性结构——前端只见"当前版本"。

## 行为

### 公共前置条件

- 必须通过现有认证；URL 中的 `message_id` 必须属于当前用户的可见（未软删除）conversation。
- URL 中的 `message_id` 自身必须 `archived_at IS NULL`（避免 stale UI 二次触发已截断的消息）。
- 经过反查后确定的"锚定 user message"也必须 `archived_at IS NULL`——由于 archive 严格作用于"位置之后"，若 URL message 未归档则其前的 user message 必然也未归档，本条相当于冗余校验，但 service 层显式断言一次。
- 锚定 conversation 不得存在 active run（status ∈ `queued/started/streaming/cancelling`）；否则返回 `409 Active run already exists`。客户端需自行先 cancel 后重试，后端不自动取消。
- 成功响应沿用 `POST /messages` 的 `SendMessageResponse { message, run }` 格式；前端用返回的 `run.id` 立即接入 `/runs/{id}/events` SSE。

### Edit-and-regenerate

- 端点：`POST /api/v1/conversations/{conversation_id}/messages/{message_id}/edit-and-regenerate`
- Body：`{ "content": "<new user text>" }`，`content` trim 后非空。
- `message_id` 必须 `role = 'user'`；传入 assistant message 返回 `409`。
- 操作（单事务内）：
  1. 将 conversation 内所有 `position >= target.position` 且 `archived_at IS NULL` 的 messages 归档（包含锚定的旧 user message 自身）。
  2. 以 `MAX(position) + 1` 插入新 user message（content = 请求体；run_id 暂为 NULL）。
  3. 插入新 run，`status = 'queued'`，`user_message_id` 指向新 user message。
  4. 回填新 user message 的 `run_id`。
  5. 更新 `conversation.updated_at`。
  6. `pg_notify('runs_queued', new_run.id)`。

### Regenerate-only

- 端点：`POST /api/v1/conversations/{conversation_id}/messages/{message_id}/regenerate`
- Body：空。
- `message_id` 可以是 `role = 'user'` 或 `role = 'assistant'`：
  - assistant：内部通过 `messages.run_id → runs.user_message_id` 反查到对应 user message 作为锚点；若 `run_id` 为 NULL（手工/异常数据）则返回 `409`。
  - user：直接作为锚点。
- 操作（单事务内）：
  1. 将 conversation 内所有 `position > anchor.position` 且 `archived_at IS NULL` 的 messages 归档（**不**归档锚定的 user message 本身）。
  2. 插入新 run，`status = 'queued'`，`user_message_id` 复用锚定 user message 的 id。
  3. 更新 `conversation.updated_at`。
  4. `pg_notify('runs_queued', new_run.id)`。

### 错误码摘要

| 情况 | 状态 | message |
|---|---|---|
| message 或 conversation 不存在 / 不属于用户 / 已软删除 / 已归档 | 404 | `Message not found` |
| 该 conversation 已有 active run | 409 | `Active run already exists` |
| edit 端点收到 role=assistant message | 409 | `Edit target must be a user message` |
| regenerate 端点收到的 assistant message 没有 run_id | 409 | `Cannot resolve user message to regenerate from` |
| edit 端点 content 缺失 / 全空白 | 422 | Pydantic 默认 |

## 数据模型

**无 schema 变更**。利用既有字段：

- `messages.archived_at` 承担截断语义；`build_context()` 与 `get_conversation_detail()` 已经按 `archived_at IS NULL` 过滤，无需改动。
- `messages.position` 单调递增，旧/新 user message 同存，position 不复用。
- `runs.user_message_id` 不要求 unique；regenerate-only 让多个 run 关联同一 user message 是允许的。
- `ux_runs_one_active_per_conversation` 在 DB 层兜底防止并发 regenerate。
- `runs.user_message_id` 的 `ON DELETE RESTRICT` 不会被触发——本设计从不删除 message，只置 `archived_at`。

## 实现边界

- 不改 worker、provider、SSE 任何代码。
- 不改 `submit_user_message` 与 `materialize_assistant_message`。
- 公共逻辑（"按 position 截断" + "插 run + notify"）抽到 `app/services/conversations/service.py` 的内部辅助函数；两个对外 service 函数（`edit_user_message_and_regenerate`、`regenerate_from_message`）调用它。
- 路由层只做依赖注入、调 service、commit；与现有 conversation/run 路由风格一致。
- 旧 run 的 `run_events`（包括 terminal event）一律保留，仅作为历史；前端不再展示其对应的 message，因为 message 已归档。

## 前端

`frontend/views/chat.js` 已经在 `renderMessage` 中预留 `message-actions` 槽位（当前放复制按钮）。

- user message 增加"编辑"按钮：点击后将 bubble 替换为多行 textarea + 确认/取消。确认时调用 edit-and-regenerate；成功后用现有 `attachRunStream({ runId, afterSeq: 0 })` 接管流，并复用其 `succeeded` 分支里"重新 fetch conversation detail"的逻辑——这是关键，因为前端 state 中存在大量需要从视图中消失的归档消息。
- assistant message 增加"重新生成"按钮：点击直接调 regenerate 端点（传入该 assistant 的 message_id），成功后流程同上。
- 任一按钮在 `state.activeRun` 存在时禁用，并附 tooltip "请先停止当前生成"。这与 409 的服务端保护协同工作。

## 验证

### Service 测试（pytest，挂真 Postgres，参考现有 conversation/run service 测试）

- A 入口：
  - 锚定中间 user message → 该 message 及其后所有未归档消息 archived；新 user message position 最大；新 run.user_message_id 指向新 user message；context builder 拼出的 history 等于"截断点之前 + 新 user"。
  - 锚定已归档 message → 404。
  - 锚定 assistant message → 409。
  - content 为空白 → 422。
- B 入口：
  - 锚定 user message → 仅该 message 之后的消息 archived，自身保留；新 run 复用原 user_message_id。
  - 锚定 assistant message → 内部反查 user message 后等价于上一条。
  - 锚定缺 run_id 的 assistant message → 409。
- A & B 通用：
  - 锚定不存在 / 跨用户 / 软删除 conversation → 404。
  - 该 conversation 已有 active run → 409，且无副作用（事务回滚后 message/run 计数不变）。

### API/集成测试

- edit-and-regenerate 走完整链路：取得 run.id → SSE `/runs/{run_id}/events` 拉到 terminal `run_succeeded` → DB 中有新的 assistant message 物化、其 `position > 新 user message`、归档列正确。
- regenerate-only 完整链路同上，且新 assistant message 与原 assistant message 共享 anchor user_message_id 但不同 run_id。
- 跨用户 / 软删除 conversation → 404；同会话并发两次 regenerate，只有第一个成功，第二个 409。

### 手动 smoke

- 前端编辑历史中间的 user message，提交后视图中后续消息消失，仅留新版本；新 assistant 流正确显示。
- 前端在 assistant message 上点"重新生成"，原 assistant 消失，新 assistant 流产生；用户消息文本不变。
- 在 active run 期间按钮 disabled；服务端依然返回 409（防止前端绕过）。

## 风险与放弃项

- **不引入分支树**：当前只做线性截断（archive）。将来若要保留多版本，可加 `messages.parent_message_id` 列，不破坏现有数据。
- **不自动 cancel 旧 run**：自动 cancel 需异步等待 `cancelling → cancelled` 才能再写 run（受 unique index 限制），代价超过收益。
- **旧 run 的 run_events 保留**：占用存储但保留审计；与"旧 message archive 不删"对称。

## 关联文档

- 架构总览：[`../../architecture/overview.md`](../../architecture/overview.md)（"已知边界"段提到 regenerate 未实现）
- 取消机制：[`2026-05-17-run-cancellation-design.md`](2026-05-17-run-cancellation-design.md)
- Conversation 模块实现：[`../../handover/2026-05-17-conversation-module.md`](../../handover/2026-05-17-conversation-module.md)
