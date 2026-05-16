# AIChat 后端 MVP 设计

日期：2026-05-16

## 目标

构建 AIChat 平台的第一个生产可用后端。产品形态类似 ChatGPT。MVP 支持用户名/邮箱加密码认证、对话管理、线性聊天、基于 DeepSeek 的 LLM 生成、持久化流式输出、显式取消，以及可重放的流式事件。

核心产品规则是：

> HTTP 连接只是观察一个 run；它不拥有 run 的生命周期。

如果客户端从流式连接断开，后端默认继续生成。客户端可以重新连接，并重放已持久化的输出事件。run 的生命周期只由后端状态转换改变，例如成功、失败、显式取消或重生成。

## 范围

首版包含：

- 用户注册和登录，支持用户名/邮箱加密码。
- JWT access token 加持久化 refresh token。
- conversation 创建、列表、详情、重命名和软删除。
- 线性 conversation message，支持 `user` 和 `assistant` 角色。
- 发送 user message 时创建 queued LLM run。
- MVP 只接入 DeepSeek，通过 `httpx` 调用其 OpenAI-compatible streaming API。
- provider 抽象，为未来接入其他 provider 留出空间。
- 文本 delta 事件持久化，每个 run 内使用单调递增的 `seq`。
- SSE 流式重放只使用 `after_seq` query cursor。
- 显式 run 取消。
- 从任意 user message 重生成：归档其后的消息并创建新 run。
- 基于 PostgreSQL 的 run 队列和独立 worker 进程。
- worker lease/heartbeat 和超时恢复。
- 结构化日志，关联 request、user、run 和 conversation。
- 核心单元测试和使用 fake provider stream 的 API 集成测试。

首版不包含：

- 前端应用。
- 邮件发送和邮箱验证流程，但会预留验证相关结构。
- 密码重置。
- 计费、额度和支付。
- Redis、Celery、LangChain、LangGraph、LiteLLM、OpenTelemetry 和 Prometheus。
- 作为一等产品能力的 conversation branch。
- 原生 EventSource 支持和 `Last-Event-ID`。
- model/provider 管理 API。

## 技术栈

- Python 3.12。
- FastAPI。
- PostgreSQL。
- SQLAlchemy 2.0 async + asyncpg。
- Alembic。
- uv。
- httpx，用于 DeepSeek HTTP streaming。
- pytest，用于测试。
- Docker Compose，用于本地和小规模生产部署。

部署形态：

- `api`：FastAPI 服务。
- `worker`：独立 async worker 进程。
- `postgres`：持久化状态存储和 run 队列。

## 架构

API 服务处理认证、conversation 和 message API、run 创建、取消、重生成，以及 SSE 事件读取。API 请求处理器不直接调用 DeepSeek。

worker 进程从 PostgreSQL 抢占 queued run，通过 lease 和 heartbeat 持有执行权，构建 provider 上下文，调用 DeepSeek streaming API，解析 provider SSE chunk，规范化文本 delta，并持久化 run event。

PostgreSQL 是 users、sessions、conversations、messages、runs 和 run_events 的事实源。它也通过 run status、lease 字段和行级抢占承担队列职责。

队列机制使用 PostgreSQL 行抢占：在事务中更新 run，并使用 `FOR UPDATE SKIP LOCKED` 或 SQLAlchemy 支持的等价锁机制。Redis 或专用任务系统明确推迟。

## 认证

用户可以使用用户名/邮箱加密码注册和登录。密码只保存安全哈希。

登录返回：

- 短期 JWT access token。
- 长期 refresh token，持久化在 PostgreSQL。

refresh token 可以被撤销，用于登出。access token 用于 REST API 和 SSE stream，形式为 `Authorization: Bearer <token>`。

user model 包含 `email_verified`，默认值为 false。MVP 不发送验证邮件。schema 包含为后续邮箱验证流程预留的 email verification token 表，这样未来加入邮箱验证时不需要重塑认证模型。

MVP 不包含密码重置。

## Conversations 和 Messages

conversation 是用户拥有的一等资源。MVP 支持：

- `POST /api/v1/conversations`
- `GET /api/v1/conversations`
- `GET /api/v1/conversations/{conversation_id}`
- `PATCH /api/v1/conversations/{conversation_id}`
- `DELETE /api/v1/conversations/{conversation_id}`

`POST /api/v1/conversations` 为新的聊天窗口创建空 conversation。`PATCH` 支持重命名。`DELETE` 软删除 conversation。软删除的 conversation 会从常规列表和详情 API 中隐藏，并且不允许继续发送新消息。已有 messages、runs 和 events 保留在数据库中，用于审计和排错。

conversation 模型是线性主线。messages 在 conversation 内有序排列，角色为 `user` 或 `assistant`。MVP 不支持 conversation-level system prompt。上下文构建使用配置中的全局默认 system prompt。

发送消息使用：

- `POST /api/v1/conversations/{conversation_id}/messages`

该接口在同一个事务中写入 user message，并创建 queued run。返回 user message id 和 run id。

每个 conversation 同时最多允许一个 active run。active 状态包括 `queued`、`started`、`streaming` 和 `cancelling`。

## 重生成

支持从任意可见 user message 发起重生成：

- `POST /api/v1/messages/{message_id}/regenerate`

目标 message 必须是当前用户拥有的 user message。

重生成语义：

1. 找到目标 user message。
2. 取消同一 conversation 中位于其后的任何 active run。
3. 软归档目标 message 之后的所有 message。
4. 使用截至并包含目标 message 的 conversation 上下文创建新的 queued run。

对产品表现来说，目标 message 之后的消息被清空。对后端来说，这些消息通过 archived metadata 保留，可用于审计和排错。

MVP 不暴露完整 conversation branch。已归档 message 不参与常规可见上下文。

## Run 状态机

run 使用 provider 无关的公开状态：

- `queued`
- `started`
- `streaming`
- `succeeded`
- `failed`
- `cancelling`
- `cancelled`

terminal 状态为 `succeeded`、`failed` 和 `cancelled`。

预期转换：

- `queued -> started -> streaming -> succeeded`
- `queued -> cancelling -> cancelled`
- `started -> failed`
- `streaming -> failed`
- `started -> cancelling -> cancelled`
- `streaming -> cancelling -> cancelled`

run 记录 created、started、first streamed、completed、failed、cancelled 和 updated 等时间戳。run 也记录 provider name、provider model、可用时的 provider request id、error code/message、usage metadata、lease owner、lease expiry 和 heartbeat time。

worker 通过事务将 queued run 移动到 `started` 并设置 lease 字段，从而 claim run。执行期间 worker 会续租 lease。如果 worker 崩溃或重启，恢复循环会把 lease 过期的 active run 标记为 `failed`，写入中断原因，并保留已有 partial run events。

## Run Events 和 Replay

provider 产生的每个文本 delta 都会被规范化为 run event。每个 event 在其 run 内有单调递增的 `seq`。

run event 示例：

- `text_delta`
- `run_started`
- `run_succeeded`
- `run_failed`
- `run_cancelled`

用户可见 stream 只要求重放 text delta event，但 terminal event 对客户端和调试都有价值。

最终 assistant message 只在 run 成功时，由累积 delta 物化生成。如果 run 在 partial output 之后失败或取消，partial run events 会保留，但不会为这些 partial output 物化 assistant message。客户端可以同时展示来自 run events 的 partial output 和 terminal run status。

## SSE API

客户端使用以下接口 stream run events：

- `GET /api/v1/runs/{run_id}/events?after_seq=0`

认证使用普通 access token：

- `Authorization: Bearer <access_token>`

MVP 只支持 `after_seq` query cursor。不支持 `Last-Event-ID`。

stream endpoint：

1. 根据 run 所属 conversation 校验当前用户权限。
2. 发送 `seq > after_seq` 的已存储 events。
3. tail 新持久化的 events。
4. 观察到 terminal run event 后结束。

SSE endpoint 不调用 DeepSeek，也不拥有 run 执行。它只读取 PostgreSQL。

## 取消

取消使用：

- `POST /api/v1/runs/{run_id}/cancel`

如果 run 处于 active 状态且属于当前用户，API 将其标记为 `cancelling`。worker 会在 provider chunk 之间和 heartbeat 工作期间检查取消状态。观察到取消后，worker 关闭 provider stream，写入 terminal cancellation event，并将 run 标记为 `cancelled`。

如果 queued run 在 worker claim 之前被取消，它会直接移动到 `cancelled`。

对 terminal run 和已经处于 `cancelling` 的 active run，取消操作是幂等的。

## DeepSeek Provider

MVP 只使用 DeepSeek，但业务逻辑依赖 provider interface，而不是 DeepSeek-specific class。

DeepSeek provider 实现：

- 直接使用 `httpx`。
- 调用 DeepSeek 的 OpenAI-compatible `/chat/completions` streaming API。
- 发送 `stream: true`。
- 解析 provider SSE `data:` 行。
- 提取 assistant text delta。
- 将 provider finish 和 error metadata 映射为规范化 run events 和 run 字段。

MVP 不使用 OpenAI Python SDK 调用 DeepSeek。这保留了对 streaming、取消、重试、超时处理和事件持久化的直接控制。

DeepSeek thinking/reasoning 支持是 provider-level 配置能力。MVP 默认关闭。默认用户可见输出只包含 assistant text。

provider 配置来自环境变量/配置：

- API key。
- Base URL。
- Model name。
- Timeout settings。
- Thinking/reasoning enabled flag。
- Default generation parameters。

MVP 不提供 provider/model 管理 API。

## 上下文构建

worker 不在执行逻辑里直接拼装 provider messages。它调用 context builder。

MVP context builder：

- 从配置中的全局默认 system prompt 开始。
- 按 conversation 顺序读取可见、未归档 messages。
- 包含截至 run 目标 user message 的上下文。
- 使用基于可配置 token 或字符预算的简单近期历史截断策略。

该设计将上下文策略隔离出来，使后续版本可以加入 summarization、provider-specific budget 或更丰富的 prompt policy，而不需要重写 worker 执行逻辑。

## 失败处理

API error 使用稳定 error code 和人类可读 message 的结构化格式。

provider failure 行为：

- 如果 DeepSeek 在任何 text delta 被持久化之前失败，worker 重试一次。
- 如果已有任何 text delta 被持久化，worker 不自动重试。
- partial events 保留。
- run 标记为 `failed`，并记录 error code 和 message。

context building failure、database failure、lease loss 和意外 worker exception 会在可行时映射为 `failed`。

worker interruption 行为：

- active run 有 lease expiry 和 heartbeat metadata。
- 恢复逻辑会把 lease 过期的 active run 标记为 failed。
- 不尝试恢复 provider HTTP stream。
- 不尝试把已经生成的 delta 自动拼进新的 provider 调用。

这可以避免生成重复或语义不一致的 assistant output。

## Usage 和可观测性

当 DeepSeek 返回 token usage 或类似 metadata 时，worker 将其保存到 run 上。usage 只用于可观测性和未来计费支持。MVP 没有 quota 或 billing 逻辑。

日志使用结构化格式，并在可用时包含以下关联字段：

- request id
- user id
- conversation id
- run id
- provider
- provider request id

metrics 和 tracing 推迟。

## 部署

MVP 使用 Docker Compose 部署：

- `api`
- `worker`
- `postgres`

配置由环境变量驱动。必需配置包括：

- PostgreSQL DSN。
- JWT secret 和 token TTL。
- Refresh token TTL。
- DeepSeek API key。
- DeepSeek base URL。
- DeepSeek model。
- 全局默认 system prompt。
- DeepSeek thinking/reasoning flag。
- Run lease duration。
- Worker poll interval。
- Worker heartbeat interval。
- Log level。

Alembic migrations 管理数据库 schema。

## 测试

默认自动化测试不调用真实 DeepSeek。

单元测试覆盖：

- Password hashing 和 token logic。
- Refresh token 持久化和撤销。
- Context builder 截断。
- DeepSeek SSE parser。
- Run 状态转换。
- Cancellation 状态转换。
- Regenerate archive 规则。

API 集成测试覆盖：

- 注册和登录。
- Token refresh 和 logout。
- Conversation 创建/列表/详情/重命名/删除。
- 发送 message 并创建 queued run。
- 从 `after_seq` 开始 SSE replay。
- Run cancellation。
- 从任意 user message regenerate。
- 用户之间的 authorization boundary。

worker 测试使用 fake provider stream 模拟：

- 成功 text deltas。
- 首个 delta 前失败，然后重试成功。
- partial delta 后失败。
- streaming 期间取消。
- lease timeout recovery 行为。

提供一个手动 DeepSeek smoke command，用真实凭据做本地验证，但它不属于默认自动化测试。

## 实现备注

项目应围绕清晰边界组织：

- `api`：route handlers 和 request/response schemas。
- `auth`：password、JWT、refresh token 行为。
- `db`：SQLAlchemy models、sessions、migrations。
- `conversations`：conversation 和 message services。
- `runs`：run 状态机、queue claiming、events、cancellation。
- `providers`：provider interface 和 DeepSeek adapter。
- `context`：provider message assembly。
- `worker`：polling、lease、execution loop、recovery。
- `core`：config、logging、error types。

route handlers 应保持薄。业务规则，例如“每个 conversation 只允许一个 active run”、“regenerate 归档后续 messages”、“SSE 只读取已持久化 events”，应该放在 service 中，以便不通过 HTTP 也能测试。

## 本规格已关闭的决策

- 使用 PostgreSQL-backed run queue，而不是 in-process background tasks 或 Redis/Celery。
- 使用 `httpx` 直接 streaming 调用 DeepSeek，而不是 OpenAI Python SDK。
- replay 只使用 `after_seq` query cursor。
- 使用 fetch-based SSE 和 Authorization header。
- MVP 只使用全局 system prompt。
- conversation 使用软删除，regenerate 移除的 messages 使用软归档。
- 每个 conversation 只允许一个 active run。
- provider failure 只在首个 persisted delta 之前重试。
