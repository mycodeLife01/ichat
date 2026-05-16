# 2026-05-16 项目骨架交接

## 本次完成

- 创建 `pyproject.toml`，定义 Python 3.12、FastAPI、SQLAlchemy async、asyncpg、Alembic、httpx、认证、安全、日志和测试相关依赖。
- 使用 `uv sync` 生成 `uv.lock` 并安装依赖。
- 创建 `app/` 下的模块目录边界：`api`、`core`、`db`、`models`、`schemas`、`services/auth`、`services/conversations`、`services/runs`、`services/providers`、`services/context`、`worker`。
- 创建 `tests/` 下与源码模块对应的测试目录。
- 创建 `docs/architecture/module-boundaries.md`，记录模块职责和跨模块规则。
- 创建 `.env.example`、`.dockerignore`、`Dockerfile` 和 `compose.yml`。
- 通过 Docker Compose 定义 `api`、`worker`、`postgres` 三个服务。
- 启动 PostgreSQL，并由官方镜像创建本地 `ichat` 数据库。

## 本次刻意未做

- 未创建 FastAPI app 入口。
- 未创建 SQLAlchemy ORM model 类。
- 未初始化 Alembic 环境。
- 未创建数据库迁移脚本。
- 未实现 auth、conversation、run、provider、context 或 worker 业务逻辑。
- 未调用真实 DeepSeek API。

## 验证命令

```bash
uv sync
uv run python -c "import alembic, asyncpg, fastapi, httpx, jwt, pydantic_settings, pwdlib, sqlalchemy, structlog, uvicorn; print('runtime dependencies ok')"
uv run pytest --version
uv run ruff --version
uv run mypy --version
docker compose config
docker compose build api worker
docker compose up -d postgres
docker compose exec -T postgres psql -U ichat -d ichat -c "select current_database(), current_user;"
```

## 接下来的开发任务

建议按以下顺序继续：

1. 创建 `app/core` 配置和结构化日志模块，读取 `.env`/环境变量。
2. 初始化 `app/db` SQLAlchemy async session 和 Alembic 环境。
3. 在 `app/models` 建立 users、refresh_tokens、email_verification_tokens 的 ORM models 和迁移。
4. 在 `app/schemas` 建立 auth 请求/响应 schemas。
5. 在 `app/services/auth` 实现 password hashing、JWT access token、refresh token service。
6. 在 `app/models` 建立 conversations、messages、runs、run_events 的 ORM models 和迁移。
7. 在 `app/schemas` 建立 conversation、message、run 请求/响应 schemas。
8. 在 `app/services/conversations`、`app/services/runs` 实现 conversation、message、run 状态机和事件 service。
9. 在 `app/services/context` 实现 context builder 的首版截断策略。
10. 在 `app/services/providers` 实现 provider interface、fake provider stream 和 DeepSeek SSE parser。
11. 在 `app/worker` 实现 worker claim、lease、heartbeat、取消检测和 recovery。
12. 在 `app/api` 实现 SSE replay endpoint，只支持 `after_seq`。

## 注意事项

- 文档必须使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 当前 Docker `api` 和 `worker` 服务只是基础容器，不代表业务服务已可用。
- 当前 PostgreSQL 数据库只有空库，没有业务表。
