# 模块边界

本文记录 iChat 后端的模块职责与依赖边界。

## 顶层结构

源码根目录使用 `app/`。领域业务逻辑集中在 `app/services/...`；与具体能力相关、主要被 worker 复用的构件（provider 协议、context 组装、prompt 组装、搜索、工具运行时）作为顶层能力模块放在 `services` 外；基础设施（`core`、`db`）与 API 契约（`models`、`schemas`）同样放在 `services` 外。

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

## `app/services/runs`

负责 run 状态机、run_events、queue claiming、取消、lease 字段、provider transcript 持久化和 replay 语义。SSE 读取持久化事件，不直接调用 provider。

## `app/services/run_events`

负责进程级 `run_events` 频道的 LISTEN/NOTIFY 订阅管理：用单条共享连接把通知 fan-out 给每个 run 的 `asyncio.Event`，供 SSE handler 唤醒，避免每个 SSE 请求各开一条 LISTEN 连接耗尽 Postgres 连接。

## `app/providers`

负责 provider interface 和具体 provider adapter（首个为 DeepSeek，使用 `httpx` 直连 OpenAI-compatible streaming API），含流式分片解析与 provider registry。

不放在 `services` 下的理由：provider 协议是被 worker 复用的能力构件；且 provider 层只做协议收发，不读取数据库。

## `app/context`

负责把 system prompt 与可见 conversation history 组装成 provider messages，按 token 预算执行截断，并以 succeeded run 的 provider transcript 作为历史 block 原子 replay。system prompt 由调用方（worker）传入，token 计数器由 provider 注入，因此 context 本身不调用 provider。

## `app/prompts`

负责生产级 system prompt 的版本化管理与按 run 注入：`base_system_prompt.md` 为基础 prompt，`build_system_prompt()` 是唯一组装入口——基础 prompt 取 `DEFAULT_SYSTEM_PROMPT` 覆盖或内置文件，并在本 run 启用联网搜索时追加当日日期与 web_search 指引段落。纯组装，不读数据库、不调用 provider。

## `app/search`

负责 provider-agnostic 搜索能力抽象：统一 `types`、`SearchClient` 协议（`client`）、`registry`（按名解析 client）、Tavily adapter（`tavily`）、结果去重/编号/证据压缩（`postprocess`）。调用外部搜索 API，不读取数据库。

## `app/tools`

负责 worker 内的工具运行时：工具类型、`web_search` 工具 schema、模型工具调用的参数解析与执行、工具结果构造。编排 `app/search` 完成搜索，工具产物由 worker 持久化为 run_events 与 provider transcript。

## `app/worker`

负责独立 worker 进程的 polling、claim run、heartbeat、构建 context、组装 system prompt、推进 provider/agent loop（含模型驱动的 web_search 工具调用）、写入 run_events 与 provider transcript、物化最终 assistant message、处理取消和 lease recovery。

不放在 `services` 下的理由：`worker` 是独立进程入口和调度边界，会调用多个模块，但本身不是领域 service。

## 跨模块规则

- `app/api` 可以调用 `app/services/...`，但不承载业务状态机，也不直接调用 provider。
- `app/worker` 可以调用 `app/context`、`app/prompts`、`app/providers`、`app/search`、`app/tools`、`app/services/...` 和 `app/db`。
- `app/providers` 不读取数据库。
- `app/context` 不调用 provider（token 计数器由调用方注入）。
- `app/prompts` 不读取数据库、不调用 provider。
- `app/search` 不读取数据库。
- `app/services/runs` 不拼装 prompt。
- `app/services/conversations` 不直接调用 provider。
- `app/models` 只定义 ORM model，不承载业务流程。
- `app/schemas` 只定义请求/响应结构，不访问数据库。
- 测试目录按模块镜像组织。
