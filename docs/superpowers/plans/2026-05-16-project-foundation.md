# AIChat 项目骨架和 Docker 环境 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 搭建 AIChat 后端项目骨架，安装首版所需依赖，创建 Docker Compose PostgreSQL 环境，并留下交接文档；本计划不实现业务代码、不创建 Alembic 迁移脚本、不编写 API/worker 逻辑。

**架构：** 本次只建立工程基础设施和模块边界。Python 依赖由 `uv` 管理，源码根目录采用 `app/`。业务逻辑收敛到 `app/services/...`，跨业务共享的 ORM models 和请求/响应 schemas 分别放在 `app/models` 和 `app/schemas`，模块职责写入中文架构文档。Docker Compose 提供 `api`、`worker`、`postgres` 三个服务，其中 `api` 和 `worker` 只是可构建基础容器，PostgreSQL 负责创建本地 `ichat` 数据库。

**技术栈：** Python 3.12、uv、FastAPI、SQLAlchemy async、asyncpg、Alembic、httpx、pytest、Docker Compose、PostgreSQL 16。

---

## 范围约束

本计划来自已审查通过的规格文档：

- `docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md`

本次执行只覆盖规格中的工程基础设施部分：

- 项目依赖和工具配置。
- 模块目录边界。
- Docker Compose 部署形态。
- PostgreSQL 数据库创建。
- handover 文档。

本次明确不做：

- FastAPI app 入口。
- SQLAlchemy ORM model 类。
- Alembic 初始化和迁移脚本。
- auth、conversation、run、provider、context、worker 的业务实现。
- 真实 DeepSeek 调用。
- 自动化测试用例。

## 文件结构

执行完成后，应有以下新增或修改文件。

**项目依赖和工具：**

- Create: `pyproject.toml`，定义项目元数据、运行时依赖、开发依赖、pytest/ruff/mypy 基础配置。
- Create: `uv.lock`，由 `uv sync` 生成并锁定依赖。

**模块边界：**

- Create: `app/api/.gitkeep`，保留 API 路由层目录。
- Create: `app/core/.gitkeep`，保留配置、日志、错误类型目录。
- Create: `app/db/.gitkeep`，保留数据库连接、session、Alembic 集成入口目录。
- Create: `app/models/.gitkeep`，保留 SQLAlchemy ORM models 目录。
- Create: `app/schemas/.gitkeep`，保留 Pydantic 请求/响应 schemas 目录。
- Create: `app/services/auth/.gitkeep`，保留认证业务 service 目录。
- Create: `app/services/conversations/.gitkeep`，保留 conversation 和 message 业务 service 目录。
- Create: `app/services/runs/.gitkeep`，保留 run 状态机、事件和队列 service 目录。
- Create: `app/services/providers/.gitkeep`，保留 provider interface 和 DeepSeek adapter 目录。
- Create: `app/services/context/.gitkeep`，保留上下文构建 service 目录。
- Create: `app/worker/.gitkeep`，保留 worker polling、lease、recovery 进程目录。
- Create: `tests/api/.gitkeep`，保留 API 测试目录。
- Create: `tests/core/.gitkeep`，保留 core 测试目录。
- Create: `tests/db/.gitkeep`，保留数据库测试目录。
- Create: `tests/models/.gitkeep`，保留 ORM model 测试目录。
- Create: `tests/schemas/.gitkeep`，保留 schema 测试目录。
- Create: `tests/services/auth/.gitkeep`，保留认证 service 测试目录。
- Create: `tests/services/conversations/.gitkeep`，保留 conversation service 测试目录。
- Create: `tests/services/runs/.gitkeep`，保留 run service 测试目录。
- Create: `tests/services/providers/.gitkeep`，保留 provider service 测试目录。
- Create: `tests/services/context/.gitkeep`，保留 context service 测试目录。
- Create: `tests/worker/.gitkeep`，保留 worker 测试目录。
- Create: `docs/architecture/module-boundaries.md`，用中文记录模块职责和禁止事项。

**Docker 和环境：**

- Create: `.dockerignore`，减少 Docker build context。
- Create: `.env.example`，列出本地开发所需环境变量示例。
- Create: `Dockerfile`，安装依赖并构建基础 runtime image。
- Create: `compose.yml`，定义 `api`、`worker`、`postgres` 服务和 `postgres_data` volume。

**交接：**

- Create: `docs/handover/2026-05-16-project-foundation.md`，说明本次完成内容、验证方式和下一轮开发任务。

## Task 1: 创建 uv 项目依赖清单

**Files:**

- Create: `pyproject.toml`
- Create: `uv.lock`

- [ ] **Step 1: 创建 `pyproject.toml`**

使用 `apply_patch` 创建 `pyproject.toml`，内容如下：

```toml
[project]
name = "ichat"
version = "0.1.0"
description = "AIChat backend service"
readme = "docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md"
requires-python = ">=3.12,<3.13"
dependencies = [
    "alembic",
    "asyncpg",
    "email-validator",
    "fastapi",
    "httpx",
    "pydantic-settings",
    "pwdlib[argon2]",
    "pyjwt[crypto]",
    "python-dotenv",
    "sqlalchemy[asyncio]",
    "loguru",
    "uvicorn[standard]",
]

[dependency-groups]
dev = [
    "mypy",
    "pytest",
    "pytest-asyncio",
    "pytest-cov",
    "ruff",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.mypy]
python_version = "3.12"
strict = true
warn_unused_configs = true
```

- [ ] **Step 2: 安装并锁定依赖**

Run:

```bash
uv sync
```

Expected:

- 命令退出码为 0。
- 生成 `uv.lock`。
- 创建 `.venv/`，该目录被 `.gitignore` 忽略。

- [ ] **Step 3: 验证运行时依赖可导入**

Run:

```bash
uv run python -c "import alembic, asyncpg, fastapi, httpx, jwt, loguru, pydantic_settings, pwdlib, sqlalchemy, uvicorn; print('runtime dependencies ok')"
```

Expected:

```text
runtime dependencies ok
```

- [ ] **Step 4: 验证开发工具可执行**

Run:

```bash
uv run pytest --version
uv run ruff --version
uv run mypy --version
```

Expected:

- 三个命令退出码均为 0。
- 输出分别包含 `pytest`、`ruff`、`mypy` 的版本信息。

- [ ] **Step 5: 提交依赖清单**

Run:

```bash
git add pyproject.toml uv.lock
git commit -m "chore: add python dependency manifest"
```

Expected:

- commit 成功。

## Task 2: 搭建模块边界骨架

**Files:**

- Create: `app/api/.gitkeep`
- Create: `app/core/.gitkeep`
- Create: `app/db/.gitkeep`
- Create: `app/models/.gitkeep`
- Create: `app/schemas/.gitkeep`
- Create: `app/services/auth/.gitkeep`
- Create: `app/services/conversations/.gitkeep`
- Create: `app/services/runs/.gitkeep`
- Create: `app/services/providers/.gitkeep`
- Create: `app/services/context/.gitkeep`
- Create: `app/worker/.gitkeep`
- Create: `tests/api/.gitkeep`
- Create: `tests/core/.gitkeep`
- Create: `tests/db/.gitkeep`
- Create: `tests/models/.gitkeep`
- Create: `tests/schemas/.gitkeep`
- Create: `tests/services/auth/.gitkeep`
- Create: `tests/services/conversations/.gitkeep`
- Create: `tests/services/runs/.gitkeep`
- Create: `tests/services/providers/.gitkeep`
- Create: `tests/services/context/.gitkeep`
- Create: `tests/worker/.gitkeep`
- Create: `docs/architecture/module-boundaries.md`

- [ ] **Step 1: 创建目录**

Run:

```bash
mkdir -p \
  app/api \
  app/core \
  app/db \
  app/models \
  app/schemas \
  app/services/auth \
  app/services/conversations \
  app/services/runs \
  app/services/providers \
  app/services/context \
  app/worker \
  tests/api \
  tests/core \
  tests/db \
  tests/models \
  tests/schemas \
  tests/services/auth \
  tests/services/conversations \
  tests/services/runs \
  tests/services/providers \
  tests/services/context \
  tests/worker \
  docs/architecture
```

Expected:

- 命令退出码为 0。

- [ ] **Step 2: 创建 `.gitkeep` 文件**

Run:

```bash
touch \
  app/api/.gitkeep \
  app/core/.gitkeep \
  app/db/.gitkeep \
  app/models/.gitkeep \
  app/schemas/.gitkeep \
  app/services/auth/.gitkeep \
  app/services/conversations/.gitkeep \
  app/services/runs/.gitkeep \
  app/services/providers/.gitkeep \
  app/services/context/.gitkeep \
  app/worker/.gitkeep \
  tests/api/.gitkeep \
  tests/core/.gitkeep \
  tests/db/.gitkeep \
  tests/models/.gitkeep \
  tests/schemas/.gitkeep \
  tests/services/auth/.gitkeep \
  tests/services/conversations/.gitkeep \
  tests/services/runs/.gitkeep \
  tests/services/providers/.gitkeep \
  tests/services/context/.gitkeep \
  tests/worker/.gitkeep
```

Expected:

- 命令退出码为 0。
- `git status --short` 能看到这些 `.gitkeep` 文件。

- [ ] **Step 3: 创建模块边界文档**

使用 `apply_patch` 创建 `docs/architecture/module-boundaries.md`，内容如下：

```markdown
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

负责数据库 engine、session、transaction helper、Alembic 集成入口和数据库工具。本次不创建迁移脚本。

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
```

- [ ] **Step 4: 验证没有业务代码文件**

Run:

```bash
find app tests -type f ! -name .gitkeep -print
```

Expected:

- 命令退出码为 0。
- 输出为空。

- [ ] **Step 5: 提交模块骨架**

Run:

```bash
git add app tests docs/architecture/module-boundaries.md
git commit -m "chore: add module boundary scaffold"
```

Expected:

- commit 成功。

## Task 3: 搭建 Docker Compose 和 PostgreSQL 环境

**Files:**

- Create: `.dockerignore`
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `compose.yml`

- [ ] **Step 1: 创建 `.dockerignore`**

使用 `apply_patch` 创建 `.dockerignore`，内容如下：

```dockerignore
.git
.superpowers
.venv
__pycache__
.pytest_cache
.ruff_cache
.mypy_cache
.env
.env.*
!.env.example
```

- [ ] **Step 2: 创建 `.env.example`**

使用 `apply_patch` 创建 `.env.example`，内容如下：

```dotenv
POSTGRES_USER=ichat
POSTGRES_PASSWORD=ichat_password
POSTGRES_DB=ichat
POSTGRES_PORT=5432

DATABASE_URL=postgresql+asyncpg://ichat:ichat_password@postgres:5432/ichat
JWT_SECRET=change-me-local-dev-only
JWT_ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000

DEEPSEEK_API_KEY=replace-in-real-deployments
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_THINKING_ENABLED=false

DEFAULT_SYSTEM_PROMPT=You are a helpful assistant.
RUN_LEASE_SECONDS=60
WORKER_POLL_INTERVAL_SECONDS=2
WORKER_HEARTBEAT_INTERVAL_SECONDS=10
LOG_LEVEL=INFO
```

- [ ] **Step 3: 创建 `Dockerfile`**

使用 `apply_patch` 创建 `Dockerfile`，内容如下：

```dockerfile
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

CMD ["python", "-c", "print('ichat container ready')"]
```

- [ ] **Step 4: 创建 `compose.yml`**

使用 `apply_patch` 创建 `compose.yml`，内容如下：

```yaml
name: ichat

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-ichat}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-ichat_password}
      POSTGRES_DB: ${POSTGRES_DB:-ichat}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build:
      context: .
    image: ichat-api:local
    command: ["python", "-c", "import time; print('api foundation container ready', flush=True); time.sleep(3600)"]
    environment:
      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER:-ichat}:${POSTGRES_PASSWORD:-ichat_password}@postgres:5432/${POSTGRES_DB:-ichat}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
    depends_on:
      postgres:
        condition: service_healthy

  worker:
    build:
      context: .
    image: ichat-worker:local
    command: ["python", "-c", "import time; print('worker foundation container ready', flush=True); time.sleep(3600)"]
    environment:
      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER:-ichat}:${POSTGRES_PASSWORD:-ichat_password}@postgres:5432/${POSTGRES_DB:-ichat}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres_data:
```

- [ ] **Step 5: 验证 Compose 配置可解析**

Run:

```bash
docker compose config
```

Expected:

- 命令退出码为 0。
- 输出包含 `services:`、`postgres:`、`api:`、`worker:` 和 `volumes:`。

- [ ] **Step 6: 构建 `api` 和 `worker` 镜像**

Run:

```bash
docker compose build api worker
```

Expected:

- 命令退出码为 0。
- 输出显示 `ichat-api:local` 和 `ichat-worker:local` 构建完成。

- [ ] **Step 7: 启动 PostgreSQL 并创建数据库**

Run:

```bash
docker compose up -d postgres
```

Expected:

- 命令退出码为 0。
- `postgres` container 进入 healthy 状态。
- PostgreSQL 镜像根据 `POSTGRES_DB=ichat` 创建 `ichat` 数据库。

- [ ] **Step 8: 验证数据库可连接**

Run:

```bash
docker compose exec -T postgres psql -U ichat -d ichat -c "select current_database(), current_user;"
```

Expected output contains:

```text
 current_database | current_user
------------------+--------------
 ichat            | ichat
```

- [ ] **Step 9: 确认未运行迁移脚本**

Run:

```bash
find . -path './.venv' -prune -o -path './.git' -prune -o -path './.superpowers' -prune -o -path '*alembic*' -print
```

Expected:

- 输出为空。

- [ ] **Step 10: 提交 Docker 环境**

Run:

```bash
git add .dockerignore .env.example Dockerfile compose.yml
git commit -m "chore: add docker compose postgres environment"
```

Expected:

- commit 成功。

## Task 4: 创建 handover 文档

**Files:**

- Create: `docs/handover/2026-05-16-project-foundation.md`

- [ ] **Step 1: 创建 handover 目录**

Run:

```bash
mkdir -p docs/handover
```

Expected:

- 命令退出码为 0。

- [ ] **Step 2: 创建 handover 文档**

使用 `apply_patch` 创建 `docs/handover/2026-05-16-project-foundation.md`，内容如下：

```markdown
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
uv run python -c "import alembic, asyncpg, fastapi, httpx, jwt, loguru, pydantic_settings, pwdlib, sqlalchemy, uvicorn; print('runtime dependencies ok')"
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
```

- [ ] **Step 3: 验证 handover 文档存在且为中文**

Run:

```bash
test -f docs/handover/2026-05-16-project-foundation.md
rg -n "本次完成|接下来的开发任务|当前 PostgreSQL 数据库只有空库" docs/handover/2026-05-16-project-foundation.md
```

Expected:

- `test` 命令退出码为 0。
- `rg` 输出命中三处中文标题或说明。

- [ ] **Step 4: 提交 handover 文档**

Run:

```bash
git add docs/handover/2026-05-16-project-foundation.md
git commit -m "docs: add project foundation handover"
```

Expected:

- commit 成功。

## Task 5: 最终验证

**Files:**

- Verify: `pyproject.toml`
- Verify: `uv.lock`
- Verify: `app/**/.gitkeep`
- Verify: `tests/**/.gitkeep`
- Verify: `docs/architecture/module-boundaries.md`
- Verify: `.env.example`
- Verify: `.dockerignore`
- Verify: `Dockerfile`
- Verify: `compose.yml`
- Verify: `docs/handover/2026-05-16-project-foundation.md`

- [ ] **Step 1: 验证 Python 依赖环境**

Run:

```bash
uv sync
uv run python -c "import alembic, asyncpg, fastapi, httpx, jwt, loguru, pydantic_settings, pwdlib, sqlalchemy, uvicorn; print('runtime dependencies ok')"
```

Expected:

```text
runtime dependencies ok
```

- [ ] **Step 2: 验证没有业务代码文件**

Run:

```bash
find app tests -type f ! -name .gitkeep -print
```

Expected:

- 输出为空。

- [ ] **Step 3: 验证 Docker 和 PostgreSQL**

Run:

```bash
docker compose config
docker compose up -d postgres
docker compose exec -T postgres psql -U ichat -d ichat -c "select current_database(), current_user;"
```

Expected:

- `docker compose config` 退出码为 0。
- PostgreSQL container healthy。
- SQL 查询结果包含 `ichat` database 和 `ichat` user。

- [ ] **Step 4: 验证未创建迁移脚本**

Run:

```bash
find . -path './.venv' -prune -o -path './.git' -prune -o -path './.superpowers' -prune -o -path '*alembic*' -print
```

Expected:

- 输出为空。

- [ ] **Step 5: 查看 git 状态**

Run:

```bash
git status --short
```

Expected:

- 输出为空。

## 自检结果

- 规格覆盖：本计划覆盖本次目标中的项目骨架、依赖安装、Docker Compose、PostgreSQL 数据库创建和 handover 文档；完整业务 MVP 留给后续计划。
- 红旗扫描：计划中没有未定词或未定义的步骤。
- 类型一致性：目录、文件名、服务名和模块名在任务之间保持一致。
