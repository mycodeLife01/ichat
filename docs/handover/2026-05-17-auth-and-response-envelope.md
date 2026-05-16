# 2026-05-17 Auth 和统一成功响应交接

## 本次完成

- 设计并实现 `/api/v1/*` JSON 成功响应薄封装：
  - 成功响应统一使用 `{"data": ...}`。
  - `meta` 可选，只有存在分页、游标或类似辅助信息时才返回。
  - `/healthz`、`/readyz` 不纳入封装，继续返回 `{"status": "ok"}`。
  - 错误响应不改变，继续使用 `{"detail": "English message"}`。
- 新增 `app/schemas/responses.py`：
  - `SuccessResponse[DataT]`
  - `ResponseMeta`
- 实现认证 API：
  - `POST /api/v1/auth/register`
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/refresh`
  - `POST /api/v1/auth/logout`
- 新增认证请求和响应 schema：
  - `RegisterRequest`
  - `LoginRequest`
  - `RefreshTokenRequest`
  - `LogoutRequest`
  - `AuthUserResponse`
  - `AuthTokenResponse`
  - `CommandStatusResponse`
- 实现认证 service：
  - 注册后直接返回 user、access token 和 refresh token。
  - 支持用户名或邮箱登录。
  - 用户名和邮箱按大小写不敏感方式检查重复。
  - 密码使用 `pwdlib[argon2]` 哈希，不保存明文。
  - access token 使用 JWT HS256，包含 `sub`、`type`、`iat`、`exp` 和 `jti`。
  - refresh token 使用随机 token，数据库只保存 SHA-256 hash。
  - refresh token 使用轮换策略：每次 refresh 撤销旧 token，并签发新 refresh token。
  - logout 幂等撤销 refresh token。
- 新增 `get_current_user()` 依赖，为后续 conversation、message 和 run API 做认证复用。
- 在 `app/main.py` 挂载 auth router。
- 简化配置来源：
  - `create_app()` 不再接收 `settings` 参数。
  - 不再写入 `app.state.settings`。
  - 当前应用配置统一通过 `get_settings()` 获取。
- 更新 `AGENTS.md`：
  - 进入实现阶段时，默认直接在当前分支开发。
  - 只有用户明确要求时才使用 git worktree。

## 文件摘要

- `app/api/v1/auth.py`：认证路由，保持 thin handler；路由负责调用 service、提交事务、返回统一成功响应。
- `app/schemas/auth.py`：认证 API 请求/响应 schema；用户名和登录标识会先 trim 再做长度校验。
- `app/schemas/responses.py`：统一成功响应 envelope。
- `app/services/auth/passwords.py`：密码哈希和校验。
- `app/services/auth/tokens.py`：JWT access token、refresh token 生成和 refresh token hash。
- `app/services/auth/service.py`：注册、登录、刷新、登出和 token 签发业务逻辑。
- `app/services/auth/dependencies.py`：当前用户解析依赖。
- `tests/api/test_auth.py`：认证 API 集成测试，使用本地 PostgreSQL，只清理 `auth-test.example.com` 测试域名下的数据。
- `tests/schemas/test_auth_schemas.py`：认证 schema 验证测试。
- `tests/schemas/test_responses.py`：统一成功响应 schema 测试。
- `tests/services/auth/test_passwords.py`：密码哈希测试。
- `tests/services/auth/test_tokens.py`：JWT 和 refresh token helper 测试。

## 数据库和迁移

- 本次未创建新迁移。
- 现有 `20260516_0001_create_core_tables.py` 已包含认证所需表：
  - `users`
  - `refresh_tokens`
  - `email_verification_tokens`
- `refresh_tokens.token_hash` 保存 refresh token hash，不保存原始 refresh token。
- access token 是无状态 JWT，不入库。
- logout 只撤销 refresh token；已签发 access token 不会立即失效，只会自然过期。

## 认证行为说明

- 注册成功返回 `201` 和：

```json
{
  "data": {
    "user": {
      "id": 1,
      "username": "alice",
      "email": "alice@example.com",
      "email_verified": false
    },
    "access_token": "...",
    "refresh_token": "...",
    "token_type": "bearer",
    "expires_in": 900
  }
}
```

- 登录成功返回 `200`，响应结构同注册。
- access token 过期后，`jwt.decode()` 会校验 `exp` 并返回 `401`：

```json
{"detail": "Invalid access token"}
```

- 后端不会自动触发 refresh。客户端应在 access token 快过期前主动调用 `/api/v1/auth/refresh`，或在业务 API 收到 `401` 后调用 refresh 并重试原请求。
- 每次 refresh 都会撤销旧 refresh token，客户端必须保存新的 refresh token。

## 时间处理说明

- 数据库时间字段使用 PostgreSQL `timestamp with time zone`，SQLAlchemy 侧为 `DateTime(timezone=True)`。
- 数据库存储绝对时间点，PostgreSQL session 默认可能显示为 UTC，例如 `2026-05-16 16:10:47+00`。
- API 后续应返回 ISO 8601 UTC 时间，例如 `2026-05-16T16:10:47.491757Z` 或 `+00:00`。
- 前端根据浏览器或用户设置转换为本地显示时间，例如上海时间 `UTC+8`。

## 本次刻意未做

- 未实现邮箱验证邮件发送。
- 未实现密码重置。
- 未实现 access token 黑名单或数据库撤销机制。
- 未实现 cookie/session 形态的认证。
- 未实现 conversation、message、run 的业务 API。
- 未实现 OpenAPI 文档细化或认证说明页面。
- 未实现前端 refresh 自动重试逻辑；refresh 触发由客户端负责。

## 验证命令

```bash
uv run pytest tests/services/auth/test_passwords.py tests/services/auth/test_tokens.py tests/api/test_auth.py -v
uv run pytest tests/api/test_app.py tests/api/test_auth.py -v
uv run pytest
uv run ruff check .
uv run mypy .
```

本次验证结果：

- auth focused tests：13 passed，后续加入 schema regression 后 focused auth tests：16 passed。
- API focused tests：15 passed。
- 最终 `uv run pytest`：46 passed。
- `uv run ruff check .`：All checks passed。
- `uv run mypy .`：Success: no issues found in 40 source files。

## 当前项目进度

已完成：

1. 项目骨架、模块边界、Docker Compose 和基础依赖。
2. FastAPI app factory、配置、日志、错误类型、健康检查和数据库 session 基础设施。
3. Alembic 基础环境和首个业务迁移。
4. MVP 核心 ORM models。
5. 统一成功响应 envelope。
6. 用户注册、登录、refresh token 轮换、登出和当前用户依赖。

仍未完成：

1. Conversation 创建、列表、详情、重命名和软删除。
2. Message 发送、queued run 创建和 active run 限制。
3. Run 状态机、取消、重生成和 run event replay。
4. SSE endpoint。
5. Context builder。
6. Provider interface、DeepSeek adapter 和 fake provider stream。
7. Worker claim、lease、heartbeat、provider stream 执行和 recovery。
8. 真实 DeepSeek smoke 验证。

## 接下来的开发任务

建议按以下顺序继续：

1. 在 `app/schemas` 建立 conversation、message、run 请求/响应 schema，并全部复用 `SuccessResponse`。
2. 在 `app/services/conversations` 实现 conversation 创建、读取、重命名和软删除，所有查询必须校验当前 user ownership。
3. 在 `app/services/conversations` 或 `app/services/runs` 实现发送 user message 并创建 queued run。
4. 补充 conversation/message/run API 集成测试，覆盖用户之间的 authorization boundary。
5. 实现 run cancellation 和 regenerate 规则。
6. 在 provider/context/worker 前，先用 fake provider stream 覆盖 run event 持久化和 replay 语义。

## 注意事项

- 文档必须使用中文；`AGENTS.md` 本身目前使用英文规则文本。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 后续所有 `/api/v1/*` JSON 成功响应都应使用 `SuccessResponse`。
- `/healthz`、`/readyz` 和 SSE 不使用成功响应 envelope。
- 后续受保护 API 应使用 `get_current_user()`。
- 配置来源保持简单：使用 `get_settings()`，不要重新引入 `app.state.settings`。
- 本项目进入实现阶段默认直接在当前分支开发，除非用户明确要求使用 worktree。
