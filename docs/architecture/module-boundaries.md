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

负责 run 状态机、run_events、queue claiming、取消、lease 字段、provider transcript 持久化和 replay 语义，以及把可见会话历史（含 succeeded run 的转写回放）加载为 agent 内核消息（`history.py`，供 worker 喂给 `app/agent` 的纯 context 组装器）。SSE 读取持久化事件，不直接调用 provider。

## `app/services/run_events`

负责进程级 `run_events` 频道的 LISTEN/NOTIFY 订阅管理：用单条共享连接把通知 fan-out 给每个 run 的 `asyncio.Event`，供 SSE handler 唤醒，避免每个 SSE 请求各开一条 LISTEN 连接耗尽 Postgres 连接。

## `app/agent`

agent 内核包（agent-runtime 重构交付一引入，见 `.scratch/agent-runtime-refactor/PRD.md`）。以 provider 中立的 content-blocks 消息模型统一 Message / Provider / Tool / Runtime 词汇：`messages`（块模型）、`provider`（Provider 协议 + StreamEvent + capabilities）、`providers/`（DeepSeek 适配器，openai SDK）、`tools/`（Tool 协议 + ToolRegistry + web_search）、`context`/`prompts`（纯组装）、`runtime`/`events`（AgentRunner、CancellationToken、RunEvent、EventSink）。

边界铁律：**内核不读数据库、不碰传输层**——`context` 只接收扁平 `list[Message]` 并按预算裁剪（DB 历史加载归 `app/services/runs`）；`AgentRunner` 只依赖 Provider、ToolRegistry、EventSink 与 CancellationToken；provider 怪癖（如 DeepSeek 无法回放 tool 历史）以 capabilities 声明收编在适配器内部；`ToolResult` 不设工具特例字段（工具专有产物走 `metadata`）。`search/` 留在包外作为基础设施被 agent 工具引用。

## `app/search`

负责 provider-agnostic 搜索能力抽象：统一 `types`、`SearchClient` 协议（`client`）、`registry`（按名解析 client）、Tavily adapter（`tavily`）、结果去重/编号/证据压缩（`postprocess`）。调用外部搜索 API，不读取数据库。

## `app/worker`

负责独立 worker 进程的 polling、claim、heartbeat 与 lease recovery，并作为薄适配器加载历史、组装 `RunConfig`、提供 `PostgresEventSink`、调用 `AgentRunner`，最后执行终态状态机转换、一次性转写落库和 assistant message 物化。provider/tool 编排循环不在 worker 内。

不放在 `services` 下的理由：`worker` 是独立进程入口和调度边界，会调用多个模块，但本身不是领域 service。

## 跨模块规则

- `app/api` 可以调用 `app/services/...`，但不承载业务状态机，也不直接调用 provider。
- `app/worker` 可以调用 `app/agent`、`app/search`、`app/services/...` 和 `app/db`，但不实现 provider/tool 编排循环。
- `app/agent` 不读取数据库、不 import ORM/`app/services`；它可以依赖 `app/core` 与 `app/search`。
- `app/search` 不读取数据库。
- `app/services/runs` 不拼装 prompt。
- `app/services/conversations` 不直接调用 provider。
- `app/models` 只定义 ORM model，不承载业务流程。
- `app/schemas` 只定义请求/响应结构，不访问数据库。
- 测试目录按模块镜像组织。
