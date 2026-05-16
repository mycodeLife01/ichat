# AIChat 项目骨架和 Docker 环境 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 搭建 AIChat 后端项目骨架，安装首版所需依赖，创建 Docker Compose PostgreSQL 环境，并留下交接文档；本计划不实现业务代码、不创建 Alembic 迁移脚本、不编写 API/worker 逻辑。

**架构：** 本次只建立工程基础设施和模块边界。Python 依赖由 `uv` 管理，源码目录采用 `src/ichat/<module>` 边界但只放 `.gitkeep`，模块职责写入中文架构文档。Docker Compose 提供 `api`、`worker`、`postgres` 三个服务，其中 `api` 和 `worker` 只是可构建基础容器，PostgreSQL 负责创建本地 `ichat` 数据库。

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
- SQLAlchemy models。
- Alembic 初始化和迁移脚本。
- auth、conversation、run、provider、worker 的业务实现。
- 真实 DeepSeek 调用。
- 自动化测试用例。

## 文件结构

执行完成后，应有以下新增或修改文件。

**项目依赖和工具：**

- Create: `pyproject.toml`，定义项目元数据、运行时依赖、开发依赖、pytest/ruff/mypy 基础配置。
- Create: `uv.lock`，由 `uv sync` 生成并锁定依赖。

**模块边界：**

- Create: `src/ichat/api/.gitkeep`，保留 API 层目录。
- Create: `src/ichat/auth/.gitkeep`，保留认证模块目录。
- Create: `src/ichat/core/.gitkeep`，保留配置、日志、错误类型目录。
- Create: `src/ichat/db/.gitkeep`，保留数据库模型、session、迁移相关目录。
- Create: `src/ichat/conversations/.gitkeep`，保留 conversation 和 message 服务目录。
- Create: `src/ichat/runs/.gitkeep`，保留 run 状态机、事件和队列目录。
- Create: `src/ichat/providers/.gitkeep`，保留 provider interface 和 DeepSeek adapter 目录。
- Create: `src/ichat/context/.gitkeep`，保留上下文构建目录。
- Create: `src/ichat/worker/.gitkeep`，保留 worker polling、lease、recovery 目录。
- Create: `tests/api/.gitkeep`，保留 API 测试目录。
- Create: `tests/auth/.gitkeep`，保留认证测试目录。
- Create: `tests/core/.gitkeep`，保留 core 测试目录。
- Create: `tests/db/.gitkeep`，保留数据库测试目录。
- Create: `tests/conversations/.gitkeep`，保留 conversation 测试目录。
- Create: `tests/runs/.gitkeep`，保留 run 测试目录。
- Create: `tests/providers/.gitkeep`，保留 provider 测试目录。
- Create: `tests/context/.gitkeep`，保留上下文测试目录。
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
    "structlog",
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
uv run python -c "import alembic, asyncpg, fastapi, httpx, jwt, pydantic_settings, pwdlib, sqlalchemy, structlog, uvicorn; print('runtime dependencies ok')"
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

- Create: `src/ichat/api/.gitkeep`
- Create: `src/ichat/auth/.gitkeep`
- Create: `src/ichat/core/.gitkeep`
- Create: `src/ichat/db/.gitkeep`
- Create: `src/ichat/conversations/.gitkeep`
- Create: `src/ichat/runs/.gitkeep`
- Create: `src/ichat/providers/.gitkeep`
- Create: `src/ichat/context/.gitkeep`
- Create: `src/ichat/worker/.gitkeep`
- Create: `tests/api/.gitkeep`
- Create: `tests/auth/.gitkeep`
- Create: `tests/core/.gitkeep`
- Create: `tests/db/.gitkeep`
- Create: `tests/conversations/.gitkeep`
- Create: `tests/runs/.gitkeep`
- Create: `tests/providers/.gitkeep`
- Create: `tests/context/.gitkeep`
- Create: `tests/worker/.gitkeep`
- Create: `docs/architecture/module-boundaries.md`

- [ ] **Step 1: 创建目录**

Run:

```bash
mkdir -p \
  src/ichat/api \
  src/ichat/auth \
  src/ichat/core \
  src/ichat/db \
  src/ichat/conversations \
  src/ichat/runs \
  src/ichat/providers \
  src/ichat/context \
  src/ichat/worker \
  tests/api \
  tests/auth \
  tests/core \
  tests/db \
  tests/conversations \
  tests/runs \
  tests/providers \
  tests/context \
  tests/worker \
  docs/architecture
```

Expected:

- 命令退出码为 0。

- [ ] **Step 2: 创建 `.gitkeep` 文件**

Run:

```bash
touch \
  src/ichat/api/.gitkeep \
  src/ichat/auth/.gitkeep \
  src/ichat/core/.gitkeep \
  src/ichat/db/.gitkeep \
  src/ichat/conversations/.gitkeep \
  src/ichat/runs/.gitkeep \
  src/ichat/providers/.gitkeep \
  src/ichat/context/.gitkeep \
  src/ichat/worker/.gitkeep \
  tests/api/.gitkeep \
  tests/auth/.gitkeep \
  tests/core/.gitkeep \
  tests/db/.gitkeep \
  tests/conversations/.gitkeep \
  tests/runs/.gitkeep \
  tests/providers/.gitkeep \
  tests/context/.gitkeep \
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

## `api`

负责 FastAPI 路由、请求/响应 schema、依赖注入入口。路由处理器应保持薄，不直接调用 DeepSeek，不直接拼装复杂业务流程。

## `auth`

负责密码哈希、JWT access token、refresh token、当前用户解析、认证相关 service。用户注册、登录、刷新 token 和登出逻辑放在这里。

## `core`

负责配置、结构化日志、错误类型、跨模块常量。业务模块可以依赖 `core`，但 `core` 不依赖业务模块。

## `db`

负责 SQLAlchemy models、数据库 session、Alembic 集成入口和数据库工具。本次不创建迁移脚本。

## `conversations`

负责 conversation 和 message 的业务规则，包括创建对话、重命名、软删除、发送 user message、读取可见消息。

## `runs`

负责 run 状态机、run_events、queue claiming、取消、lease 字段和 replay 语义。SSE 读取持久化事件，不直接调用 provider。

## `providers`

负责 provider interface 和具体 provider adapter。MVP 首个 adapter 是 DeepSeek，使用 `httpx` 直接调用 OpenAI-compatible streaming API。

## `context`

负责把全局 system prompt 和可见 conversation messages 组装成 provider messages，并执行首版截断策略。

## `worker`

负责独立 worker 进程的 polling、claim run、heartbeat、执行 provider stream、写入 run_events、处理取消和 lease recovery。

## 跨模块规则

- `api` 可以调用 service，但不承载业务状态机。
- `worker` 可以调用 `runs`、`context`、`providers` 和 `db`。
- `providers` 不读取数据库。
- `context` 不调用 provider。
- `runs` 不拼装 prompt。
- `conversations` 不直接调用 provider。
- 测试目录按模块镜像组织。
```

- [ ] **Step 4: 验证没有业务代码文件**

Run:

```bash
find src tests -type f ! -name .gitkeep -print
```

Expected:

- 命令退出码为 0。
- 输出为空。

- [ ] **Step 5: 提交模块骨架**

Run:

```bash
git add src tests docs/architecture/module-boundaries.md
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
    command: ["python", "-c", "import time; print('api placeholder container ready', flush=True); time.sleep(3600)"]
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
    command: ["python", "-c", "import time; print('worker placeholder container ready', flush=True); time.sleep(3600)"]
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
- 创建 `src/ichat/` 下的模块目录边界：`api`、`auth`、`core`、`db`、`conversations`、`runs`、`providers`、`context`、`worker`。
- 创建 `tests/` 下与源码模块对应的测试目录。
- 创建 `docs/architecture/module-boundaries.md`，记录模块职责和跨模块规则。
- 创建 `.env.example`、`.dockerignore`、`Dockerfile` 和 `compose.yml`。
- 通过 Docker Compose 定义 `api`、`worker`、`postgres` 三个服务。
- 启动 PostgreSQL，并由官方镜像创建本地 `ichat` 数据库。

## 本次刻意未做

- 未创建 FastAPI app 入口。
- 未创建 SQLAlchemy models。
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

1. 创建 `core` 配置和结构化日志模块，读取 `.env`/环境变量。
2. 初始化 SQLAlchemy async session 和 Alembic 环境。
3. 建立 users、refresh_tokens、email_verification_tokens 的 models 和迁移。
4. 实现 password hashing、JWT access token、refresh token service。
5. 建立 conversations、messages 的 models、迁移和 service。
6. 建立 runs、run_events 的 models、迁移和 run 状态机。
7. 实现 context builder 的首版截断策略。
8. 实现 provider interface、fake provider stream 和 DeepSeek SSE parser。
9. 实现 worker claim、lease、heartbeat、取消检测和 recovery。
10. 实现 SSE replay endpoint，只支持 `after_seq`。

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
- Verify: `src/ichat/**/.gitkeep`
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
uv run python -c "import alembic, asyncpg, fastapi, httpx, jwt, pydantic_settings, pwdlib, sqlalchemy, structlog, uvicorn; print('runtime dependencies ok')"
```

Expected:

```text
runtime dependencies ok
```

- [ ] **Step 2: 验证没有业务代码文件**

Run:

```bash
find src tests -type f ! -name .gitkeep -print
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
