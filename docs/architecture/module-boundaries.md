# 模块边界

本文记录 iChat 后端的模块职责与依赖边界。

## 顶层结构

源码根目录使用 `app/`。领域业务逻辑集中在 `app/services/...`；provider 中立的 agent 内核集中在 `app/agent`，搜索基础设施集中在 `app/search`；基础设施（`core`、`db`）与 API 契约（`models`、`schemas`）同样放在 `services` 外。

## `app/api`

负责 FastAPI 路由、引用请求/响应 schema、依赖注入入口。路由处理器应保持薄，不直接调用 provider，不直接拼装复杂业务流程。

不放在 `services` 下的理由：`api` 是传输层入口，不是业务能力本身。

## `app/core`

负责配置、结构化日志、错误类型、跨模块常量。业务模块可以依赖 `core`，但 `core` 不依赖业务模块。

不放在 `services` 下的理由：`core` 是全局基础设施，不能依赖任何业务 service。

## `app/db`

负责数据库 engine、session、transaction helper、Alembic 集成入口和数据库工具。

不放在 `services` 下的理由：`db` 是持久化基础设施，供 models 和 services 使用。

## `app/models`

负责 SQLAlchemy ORM model 类：users、refresh_tokens、conversations、messages、runs、run_events、run_provider_messages 等。

不放在 `services` 下的理由：ORM models 描述数据库结构和跨业务关系，会被多个 service、migration 和 query 使用。

## `app/schemas`

负责 Pydantic 请求/响应 schema。API 层使用 schema 定义接口边界，service 层可以返回内部对象或 schema 组装所需数据。

不放在 `services` 下的理由：schemas 是 API contract，不是业务行为；同一个 response 可能组合多个 service 的数据。

## `app/services/auth`

负责密码哈希、JWT access token、refresh token、当前用户解析、认证相关 service。用户注册、登录、刷新 token 和登出逻辑放在这里。

## `app/services/conversations`

负责 conversation 和 message 的业务规则，包括创建对话、重命名、软删除、发送 user message、物化 assistant message、读取可见消息。

## `app/services/avatars`

负责头像专用领域：上传会话状态机、R2/CDN/任务发布协议、图片验证与转码编排、替换原子切换、删除补偿、注销失效和周期维护。不抽象为通用 files/assets 模块。API 只创建/确认/查询会话，不接收图片字节；媒体 Celery worker 调用该 service 处理私有临时对象。

## `app/services/runs`

负责 run 状态机、queue claiming、取消、lease/recovery、语义 `run_events`、`run_drafts` checkpoint、provider transcript 持久化和 replay/state 拼装语义；`events.py` 定义 worker 使用的 `RunEvent`/`RunEventType`，`drafts.py` 提供快照 upsert/read/delete，`history.py` 把可见会话历史（含 succeeded run 的转写回放）加载为 agent 内核消息。Redis 只是传输加速器，Run 所有权与终态事实仍归本模块和 PG。

## `app/services/run_events`

负责 Redis Run Stream 传输适配：`RedisRunEventStream` 统一 XADD/MAXLEN/双重 TTL、XRANGE replay、每连接 XREAD BLOCK、entry 编解码与短超时。该模块不决定 Run 状态，不持有业务事实；调用方必须能在 Redis 失败时退回 `services/runs` 的 PG 语义事件与 draft checkpoint。

## `app/agent`

agent 内核包——**project-level agent building blocks**（04b 再分层后收敛，见 `.scratch/agent-runtime-refactor/issues/04b-agent-layering.md`）。内容：`messages`（content-blocks 消息模型）、`provider`（Provider 协议 + StreamEvent + capabilities）、`providers/`（DeepSeek 适配器，构造用显式窄参不吃 Settings）、`tools/`（Tool 协议 + ToolRegistry + web_search）、单次模型调用原语 `stream_model_call`、工具执行原语 `execute_tool`、AgentEvent 事件词汇（TextDelta/ReasoningDelta/ToolCallStarted/ToolCallFinished/MessageDone/AgentFinal）。

边界铁律：**内核不 import `app.core.config`、不读数据库、不 import ORM/`app/services`、不碰传输层**；词汇表中无 run、无 seq、无 sink、无取消（仅需对 asyncio 取消传播安全）。agent 循环与业务装配归 `app/services/agents`；provider 怪癖以 capabilities 声明收编在适配器内部；`ToolResult` 不设工具特例字段（工具专有产物走 `metadata`）。`search/` 留在包外作为基础设施被 agent 工具引用。

## `app/services/agents`

agent 编排层（04b 引入）——**agent 循环的主人**，对应 LangChain 的 harness 层（`create_agent`）。负责：`resolve_provider` 注册表（Settings→适配器窄参的展开发生在这里）、system prompt 组装、context 预算裁剪（`Turn` 词汇归此）、工具装配、`max_tool_calls` 与声明式 `RetryPolicy`；`build_chat_agent(...) -> ChatAgent`，`ChatAgent.stream()` 内执行 model call 调度与工具分发循环，向上 yield AgentEvent。未来的 middleware、HITL、条件工具路由在此层生长。

**生成器即边界**：编排层只 yield 事件宣告，不知道 seq/sink/发布/持久化；与取消无关（仅需取消安全）。`SourceRegistry` 等单一工具的私有产物以闭包内化，通过 `assistant_metadata` 中性钩子交给 worker，web_search/sources/tavily 词汇不出包。不读数据库——历史加载归 `app/services/runs`。

## `app/search`

负责 provider-agnostic 搜索能力抽象：统一 `types`、`SearchClient` 协议（`client`）、`registry`（按名解析 client）、Tavily adapter（`tavily`）、结果去重/编号/证据压缩（`postprocess`）。调用外部搜索 API，不读取数据库。

## `app/worker`

负责独立 worker 进程的 Redis 唤醒 + PG polling、claim、heartbeat 与 lease recovery，以及 run 执行的**纯工程化**：调 `services/runs` 加载历史、调 `services/agents` 构建 `ChatAgent`、消费 `agent.stream()`（seq 分配、AgentEvent→外部 RunEvent 映射、重试执行、取消）、通过 `RedisStreamSink` / `PostgresEventSink` / `DraftCheckpointSink` / `FanoutSink` 发布与持久化、终态状态机转换、转写落库和 assistant message 物化。标题 prompt/模型选择/清洗归 `services/agents/title_agent.py`，标题执行归 Celery `tasks/llm_tasks.py`；worker 不含标题业务组装。

不放在 `services` 下的理由：`worker` 是独立进程入口和调度边界，会调用多个模块，但本身不是领域 service。

## 跨模块规则

- `app/api` 可以调用 `app/services/...`，但不承载业务状态机，也不直接调用 provider。
- `app/worker` 可以调用 `app/agent`、`app/search`、`app/services/...` 和 `app/db`，但不做业务组装决策，不实现 agent 循环。
- `app/services/agents` 依赖 `app/agent`、`app/core`、`app/search`；不读数据库、不 import 传输/发布设施。
- `app/agent` 不 import `app.core.config`、不读取数据库、不 import ORM/`app/services`；可以依赖 `app/search`。
- `app/search` 不读取数据库。
- `app/services/runs` 不拼装 prompt。
- `app/services/conversations` 不直接调用 provider。
- `app/models` 只定义 ORM model，不承载业务流程。
- `app/schemas` 只定义请求/响应结构，不访问数据库。
- 测试目录按模块镜像组织。
