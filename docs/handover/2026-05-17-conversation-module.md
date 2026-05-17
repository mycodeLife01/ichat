# 2026-05-17 Conversation 模块交接

## 本次完成

- 实现 Conversation API：
  - `POST /api/v1/conversations`
  - `GET /api/v1/conversations`
  - `GET /api/v1/conversations/{conversation_id}`
  - `PATCH /api/v1/conversations/{conversation_id}`
  - `DELETE /api/v1/conversations/{conversation_id}`
  - `POST /api/v1/conversations/{conversation_id}/messages`
- 新增 conversation、message、run 相关请求和响应 schema：
  - `ConversationCreateRequest`
  - `ConversationRenameRequest`
  - `MessageCreateRequest`
  - `ConversationResponse`
  - `ConversationDetailResponse`
  - `MessageResponse`
  - `RunResponse`
  - `SendMessageResponse`
- 实现 Conversation service：
  - 创建 conversation。
  - 按当前用户列出未删除 conversations。
  - 获取 conversation 详情，并只返回未归档 messages。
  - 重命名 conversation。
  - 软删除 conversation。
  - 提交 user message 并创建 `queued` run。
- 在 `app/main.py` 挂载 conversation router。
- 所有 conversation API 复用现有 `get_current_user()` 认证依赖。
- 所有 conversation API 成功 JSON 响应复用 `SuccessResponse`，格式为 `{"data": ...}`。
- 所有 ownership 失败和软删除后的访问统一返回 `404`：

```json
{"detail": "Conversation not found"}
```

- active run 存在时再次发送消息返回 `409`：

```json
{"detail": "Active run already exists"}
```

## 文件摘要

- `app/schemas/conversations.py`：conversation、message、run 的 API 请求和响应 schema。
- `app/services/conversations/__init__.py`：导出 conversation service public API。
- `app/services/conversations/service.py`：conversation CRUD、ownership 校验、软删除、可见消息读取、message position 分配、active run 检查、queued run 创建。
- `app/api/v1/conversations.py`：conversation 和 message API route，保持 thin handler。
- `app/main.py`：挂载 conversation router。
- `tests/schemas/test_conversation_schemas.py`：conversation schema 验证测试。
- `tests/services/conversations/test_service.py`：conversation service 业务规则测试。
- `tests/api/test_conversations.py`：conversation API 集成测试。
- `docs/superpowers/plans/2026-05-17-conversation-module.md`：本模块实现计划。

## API 行为说明

- `POST /api/v1/conversations` 支持可选 `title`：
  - 空字符串或全空白 title 会被规范化为 `null`。
  - 非空 title 会 trim。
  - 成功返回 `201`。
- `GET /api/v1/conversations`：
  - 只返回当前用户拥有且未软删除的 conversations。
  - 排序为 `updated_at desc, id desc`。
- `GET /api/v1/conversations/{conversation_id}`：
  - 校验当前用户 ownership。
  - 不返回已软删除 conversation。
  - `messages` 只包含 `archived_at is null` 的可见消息。
- `PATCH /api/v1/conversations/{conversation_id}`：
  - title 会 trim。
  - 空白 title 会被 Pydantic 校验拒绝。
  - 使用数据库时间更新 `updated_at`，避免应用进程时间和数据库时间出现偏差。
- `DELETE /api/v1/conversations/{conversation_id}`：
  - 软删除 conversation，写入 `deleted_at` 并更新 `updated_at`。
  - 返回 `{"data": {"status": "ok"}}`。
- `POST /api/v1/conversations/{conversation_id}/messages`：
  - 请求体为 `{"content": "..."}`。
  - 空白 content 会被 Pydantic 校验拒绝。
  - service 函数名为 `submit_user_message()`，语义是“提交用户消息并创建 queued run”，不是只用于首次交流。
  - 在同一事务中创建 `messages` 的 user message 和 `runs` 的 `queued` run。
  - 新 user message 的 `run_id` 指向新 run。
  - `provider_name` 当前固定为 `deepseek`。
  - `provider_model` 来自 `settings.deepseek_model`。
  - 如果同一 conversation 已存在 active run，则拒绝再次发送。

## 数据库和迁移

- 本次未创建新迁移。
- 现有 `20260516_0001_create_core_tables.py` 已包含本模块所需表和约束：
  - `conversations`
  - `messages`
  - `runs`
- active run 限制依赖既有 partial unique index：
  - 同一 conversation 同时只能有一个 `queued`、`started`、`streaming` 或 `cancelling` run。
- service 层也会在提交 user message 前主动查询 active run，并返回稳定业务错误。
- `submit_user_message()` 会对目标 conversation 使用 `SELECT ... FOR UPDATE`，减少并发提交时 position 分配和 active run 检查的竞争窗口。

## 实现注意事项

- Conversation 模块目前仍放在 `app/services/conversations`，没有拆独立 message service。
- `submit_user_message()` 放在 conversation service 的原因：
  - 它需要校验 conversation ownership。
  - 它需要校验 conversation 未软删除。
  - 它需要分配 conversation 内 message position。
  - 它需要检查 conversation active run。
  - 它需要更新 conversation `updated_at`。
  - 它需要同事务写入 user message 和 queued run。
- `get_database_now()` 使用数据库 `now()`，避免应用进程时间早于数据库 `created_at`，导致 `updated_at < created_at`。
- `rename_conversation()` 在 flush 后显式 `refresh(conversation)`，避免 SQLAlchemy async 在 Pydantic `model_validate()` 读取 `updated_at` 时触发隐式 IO。
- 当前 API 仍只返回 JSON，不包含 SSE。

## 本次刻意未做

- 未实现 run event 写入和 `seq` 分配。
- 未实现 SSE replay endpoint。
- 未实现 run cancellation。
- 未实现 regenerate。
- 未实现 context builder。
- 未实现 provider interface、DeepSeek adapter 或 fake provider stream。
- 未实现 worker claim、lease、heartbeat、provider stream 执行和 recovery。
- 未实现真实 DeepSeek smoke 验证。
- 未实现 conversation 分页；当前列表直接返回全部未删除 conversations。

## 验证命令

```bash
uv run pytest tests/schemas/test_conversation_schemas.py tests/services/conversations/test_service.py tests/api/test_conversations.py -v
uv run pytest tests/api/test_app.py tests/api/test_auth.py tests/api/test_conversations.py -v
uv run pytest
uv run ruff check .
uv run mypy .
```

本次验证结果：

- Conversation focused tests：20 passed。
- API focused tests：19 passed。
- 最终 `uv run pytest`：66 passed。
- `uv run ruff check .`：All checks passed。
- `uv run mypy .`：Success: no issues found in 47 source files。

验证依赖：

- 本地 PostgreSQL 需要可用。
- 本次使用 Docker Compose 启动本地 `postgres` 服务。
- Conversation 测试默认使用：

```text
postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat
```

## 当前项目进度

已完成：

1. 项目骨架、模块边界、Docker Compose 和基础依赖。
2. FastAPI app factory、配置、日志、错误类型、健康检查和数据库 session 基础设施。
3. Alembic 基础环境和首个业务迁移。
4. MVP 核心 ORM models。
5. 统一成功响应 envelope。
6. 用户注册、登录、refresh token 轮换、登出和当前用户依赖。
7. Conversation 创建、列表、详情、重命名和软删除。
8. 提交 user message 并创建 queued run。
9. 每个 conversation 一个 active run 的 service/API 覆盖。

仍未完成：

1. Run event 写入、递增 `seq` 和持久化 replay 查询。
2. SSE endpoint。
3. Run cancellation。
4. Regenerate 归档规则。
5. Context builder。
6. Provider interface、DeepSeek adapter 和 fake provider stream。
7. Worker claim、lease、heartbeat、provider stream 执行和 recovery。
8. 真实 DeepSeek smoke 验证。

## 接下来的开发任务

建议下一步先做 `Run Events And SSE Replay`：

1. 在 `app/services/runs` 实现 run event 写入 helper，保证同一 run 内 `seq` 单调递增。
2. 实现 run ownership 查询，所有 run API 必须通过 run 所属 conversation 校验当前 user。
3. 实现 `GET /api/v1/runs/{run_id}/events?after_seq=0`。
4. 先用数据库中已持久化的 fake events 测试 replay 语义。
5. 覆盖 terminal event 后 stream 结束。

后续再做：

1. Run cancellation。
2. Regenerate。
3. Context builder。
4. Provider interface 和 fake provider。
5. DeepSeek adapter。
6. Worker 执行 loop。

## Git 状态

- 最新相关提交：

```text
b003756 feat: implement conversation management with message submission and CRUD operations
3358e79 feat: add conversation service
6a5637b feat: add conversation schemas
8299f47 docs: add conversation module plan
```

- 写入本交接文档前，工作区为 clean。
- 写入本交接文档后，当前新增 `docs/handover/2026-05-17-conversation-module.md` 待提交。

## 注意事项

- 文档必须使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 后续所有 `/api/v1/*` JSON 成功响应继续使用 `SuccessResponse`。
- `/healthz`、`/readyz` 和后续 SSE 不使用成功响应 envelope。
- 受保护 API 继续使用 `get_current_user()`。
- 后续 run API 不应只根据 run id 直接放行，必须通过 run 所属 conversation 校验当前用户 ownership。
- provider 和 worker 不应被 API handler 直接调用；HTTP 连接只观察 run，不拥有 run 生命周期。
