# 模块边界

本文记录 AIChat 后端首版的模块职责。本次项目骨架只创建目录和文档，不实现业务代码。

## 顶层结构

源码根目录使用 `app/`。业务逻辑集中在 `app/services/...`，跨业务共享的结构定义和基础设施模块保留在 `services` 外。

## `app/api`

负责 FastAPI 路由、引用请求/响应 schema、依赖注入入口。路由处理器应保持薄，不直接调用 DeepSeek，不直接拼装复杂业务流程。

不放在 `services` 下的理由：`api` 是传输层入口，不是业务能力本身。

## `app/core`

负责配置、结构化日志、错误类型、跨模块常量。业务模块可以依赖 `core`，但 `core` 不依赖业务模块。

不放在 `services` 下的理由：`core` 是全局基础设施，不能依赖任何业务 service。

## `app/db`

负责数据库 engine、session、transaction helper、Alembic 集成入口和数据库工具。业务表迁移脚本由后续模型任务创建。

不放在 `services` 下的理由：`db` 是持久化基础设施，供 models 和 services 使用。

## `app/models`

负责 SQLAlchemy ORM model 类。后续 users、refresh_tokens、conversations、messages、runs、run_events 等 ORM model 放在这里。

不放在 `services` 下的理由：ORM models 描述数据库结构和跨业务关系，会被多个 service、migration 和 query 使用。

## `app/schemas`

负责 Pydantic 请求/响应 schema。API 层使用 schema 定义接口边界，service 层可以返回内部对象或 schema 组装所需数据。

不放在 `services` 下的理由：schemas 是 API contract，不是业务行为；同一个 response 可能组合多个 service 的数据。

## `app/services/auth`

负责密码哈希、JWT access token、refresh token、当前用户解析、认证相关 service。用户注册、登录、刷新 token 和登出逻辑放在这里。

## `app/services/conversations`

负责 conversation 和 message 的业务规则，包括创建对话、重命名、软删除、发送 user message、读取可见消息。

## `app/services/runs`

负责 run 状态机、run_events、queue claiming、取消、lease 字段和 replay 语义。SSE 读取持久化事件，不直接调用 provider。

## `app/services/providers`

负责 provider interface 和具体 provider adapter。MVP 首个 adapter 是 DeepSeek，使用 `httpx` 直接调用 OpenAI-compatible streaming API。

## `app/services/context`

负责把全局 system prompt 和可见 conversation messages 组装成 provider messages，并执行首版截断策略。

## `app/worker`

负责独立 worker 进程的 polling、claim run、heartbeat、执行 provider stream、写入 run_events、处理取消和 lease recovery。

不放在 `services` 下的理由：`worker` 是独立进程入口和调度边界，会调用多个 service，但本身不是领域 service。

## 跨模块规则

- `app/api` 可以调用 `app/services/...`，但不承载业务状态机。
- `app/worker` 可以调用 `app/services/runs`、`app/services/context`、`app/services/providers` 和 `app/db`。
- `app/services/providers` 不读取数据库。
- `app/services/context` 不调用 provider。
- `app/services/runs` 不拼装 prompt。
- `app/services/conversations` 不直接调用 provider。
- `app/models` 只定义 ORM model，不承载业务流程。
- `app/schemas` 只定义请求/响应结构，不访问数据库。
- 测试目录按模块镜像组织。
