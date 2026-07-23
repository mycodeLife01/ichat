# iChat

iChat 是一个前后端分离的 AI 聊天服务。后端使用 FastAPI，流式 Run 由独立
Worker 执行并通过 SSE 推送；前端是部署在 Cloudflare Pages 的 React SPA。
当前接入 DeepSeek，并通过 provider-neutral agent kernel 保留扩展其他模型与工具的边界。

## 功能

- **实时对话**：文本与推理内容流式输出，支持断线重连、`after_seq` 游标重放和刷新恢复
- **Agent 工具调用**：模型按需调用 Tavily Web Search，工具事件与来源元数据随 Run 持久化
- **推理级别**：每次发送、编辑或重生成均可覆盖 thinking mode 与 reasoning effort
- **对话管理**：草稿对话、自动标题、重命名、软删除、编辑消息、重生成和运行取消
- **对话分享**：创建时生成只读快照，支持公开链接、所有者查询和撤销
- **完整账户流程**：JWT Access/Refresh Token、邮箱验证、密码重置、修改密码和账户停用
- **头像上传**：浏览器裁剪后直传 Cloudflare R2，由独立媒体队列校验、转码和清理
- **故障恢复**：PostgreSQL Run 队列、租约与心跳保证唯一执行；Redis 故障时可退化到
  PostgreSQL 轮询和 draft checkpoint

## 技术栈

| 层级 | 技术 |
|---|---|
| API | Python 3.12、FastAPI、Pydantic、SQLAlchemy 2.0 async、Alembic |
| Agent | provider-neutral content blocks、Provider/Tool protocols、DeepSeek adapter、Tavily |
| 异步执行 | asyncio Worker、Celery Worker/Beat |
| 状态与传输 | PostgreSQL 16、Redis 7 Streams/Pub/Sub |
| 认证与媒体 | PyJWT、Argon2、Postmark/Resend、Cloudflare R2 |
| 前端 | React 19、TypeScript、Vite、Tailwind CSS v4、React Router |
| 测试与质量 | pytest、ruff、mypy、Vitest、Testing Library、MSW、ESLint |
| 部署 | Docker Compose、Nginx、GitHub Actions、GHCR、Cloudflare Pages |

## 快速开始

前置要求：

- Docker 与 Docker Compose
- DeepSeek API Key
- 前端本地开发另需 Node.js 22+ 和 pnpm

```bash
# 1. 克隆并进入仓库
git clone <repo-url>
cd ichat

# 2. 创建本地配置
cp .env.example .env
# 至少修改 JWT_SECRET 和 DEEPSEEK_API_KEY

# 3. 启动 PostgreSQL、Redis、迁移、API、流式 Worker 和 Celery 服务
docker compose up -d

# 4. 启动前端
cd frontend
pnpm install
echo "VITE_API_BASE_URL=http://localhost:8000/api/v1" > .env.local
pnpm dev
```

打开：

- 前端：<http://localhost:5173>
- OpenAPI：<http://localhost:8000/docs>
- 存活检查：<http://localhost:8000/healthz>
- 就绪检查：<http://localhost:8000/readyz>

`.env.example` 默认使用 console 邮件 provider，并关闭 Web Search 与头像存储，因此本地启动
不需要邮件服务、Tavily 或 R2 凭据。启用这些集成前，请填写对应配置。

## 运行时架构

```text
Browser
  │
  ├── React SPA ───────────────────────────── Cloudflare Pages
  │
  └── HTTPS / SSE
          │
          ▼
        Nginx
          │
          ▼
     FastAPI API
       │      │
       │      ├── PostgreSQL：业务事实源、Run 队列、语义事件、draft checkpoint
       │      └── Redis：Run Stream、排队/取消信号、认证限流、Celery broker
       │
       ├────────► asyncio Worker × N ──► ChatAgent ──► DeepSeek / Tavily
       │             └── claim、lease、heartbeat、流式事件写入
       │
       └────────► Celery
                     ├── 邮件 outbox
                     ├── 对话标题生成
                     └── 头像处理与维护 ──► Cloudflare R2
```

### Agent runtime 分层

大型重构后，Agent 运行时分为三个明确层次：

1. `app/agent/` 是纯 kernel，只提供 provider-neutral 消息模型、Provider/Tool 协议、
   AgentEvent 词汇、adapter 和单次模型调用/工具执行原语；它不依赖数据库、配置或
   Worker。
2. `app/services/agents/` 是编排层，负责上下文预算、系统提示词、工具注册、模型/工具循环、
   重试策略，并通过中性的 AgentEvent 暴露执行过程。
3. `app/worker/` 是平台执行层，负责 Run claim、租约、取消、序号分配、event sink、
   checkpoint、状态机和最终持久化；API 与运行服务负责 SSE 读取和恢复合并。

这个边界使 agent loop 可独立测试，也避免把数据库和 Redis 泄漏到 kernel；DeepSeek
wire format 则被封装在 kernel 的 provider adapter 内，不进入中性消息词汇和编排层。

### Run 与 SSE

1. API 在同一个 PostgreSQL 事务中写入用户消息和 queued Run，提交后通过 Redis
   `runs_queued` 发布唤醒提示。
2. Worker 始终用 `FOR UPDATE SKIP LOCKED` claim；Redis 只负责低延迟唤醒，不决定所有权。
3. `ChatAgent.stream()` 产出的文本、推理与工具事件由 Worker 分配单调 `seq`。
4. 高频增量写入每个 Run 独立的 Redis Stream；语义事件、终态和低频 draft checkpoint
   写入 PostgreSQL。
5. SSE 合并 PostgreSQL 与 Redis 事件并按 `seq` 去重。Redis 不可用时，客户端仍可通过
   PostgreSQL checkpoint 获得较粗粒度的恢复结果。

PostgreSQL 是业务事实源；Redis 是可降级的实时传输与唤醒层。详细约束见
[架构总览](docs/architecture/overview.md)和[模块边界](docs/architecture/module-boundaries.md)。

## 项目结构

```text
app/
├── agent/              # 纯 Agent kernel：消息、Provider/Tool 协议、adapter、原语
├── api/v1/             # FastAPI 路由：auth、avatar、conversation、run、share
├── core/               # 配置、日志、应用错误
├── db/                 # async/sync 数据库 session
├── models/             # SQLAlchemy ORM 模型
├── schemas/            # API 请求与响应模型
├── search/             # SearchClient 协议、Tavily adapter、证据处理
├── services/
│   ├── agents/         # ChatAgent/TitleAgent 编排、上下文、提示词
│   ├── auth/           # 认证、token、密码与限流
│   ├── avatars/        # 头像上传会话和媒体作业
│   ├── conversations/  # 对话、消息、重生成和标题作业
│   ├── email/          # outbox、渲染与邮件 provider
│   ├── run_events/     # Redis Run Stream 适配
│   ├── runs/           # Run 生命周期、PG 事件、历史、draft、恢复与唤醒
│   └── shares/         # 对话分享快照
├── tasks/              # Celery app 与邮件、标题、媒体任务
├── worker/             # 流式 Run Worker
└── main.py             # FastAPI 入口

frontend/
├── src/api/            # API client、SSE parser、错误类型
├── src/app/            # App shell、provider、reducer store
├── src/auth/           # 登录注册、验证邮箱、重置密码
├── src/conversations/  # 对话列表、详情与用户分享列表
├── src/messages/       # 消息渲染与公开分享页
├── src/runs/           # 流式订阅、恢复、取消、推理/搜索选项
├── src/styles/         # Tailwind v4 全局主题
└── src/ui/             # 通用 UI 组件与分享对话框

alembic/                # 数据库迁移
deploy/                 # Nginx 配置
docs/                   # 架构、设计、交接与部署文档
tests/                  # 后端测试；前端测试与源码同目录
compose.yml             # 本地完整服务拓扑
compose.prod.yml        # 生产服务拓扑
```

## API 概览

所有业务 API 使用 `/api/v1` 前缀；对话、消息和 Run 在公开接口上使用 UUID，
数据库自增主键不参与这些资源的 URL。

| 路径组 | 能力 |
|---|---|
| `/auth/*` | 注册、登录、刷新、登出、个人资料、邮箱验证、密码和账户生命周期 |
| `/auth/me/avatar-uploads/*` | 创建直传会话、确认上传、查询处理状态 |
| `/capabilities` | 返回当前可用的 Web Search 等服务端能力 |
| `/conversations/*` | 对话 CRUD、发送、编辑、重生成、创建/查询/撤销分享 |
| `/runs/{id}/state` | 获取 Run 状态与可恢复快照 |
| `/runs/{id}/events` | 订阅 SSE；支持 `after_seq` |
| `/runs/{id}/cancel` | 取消 queued 或正在执行的 Run |
| `/share/{token}` | 匿名读取只读分享快照 |
| `/shares` | 查询当前用户创建的分享 |

响应成功体统一为 `{"data": ...}`。完整 schema 与状态码以运行中的 `/docs` 为准。

## 配置

后端从 `.env` 读取配置，完整字段、默认值和注释见
[`.env.example`](.env.example)。常用配置分组如下：

| 分组 | 关键变量 |
|---|---|
| 基础 | `DATABASE_URL`、`JWT_SECRET`、`CORS_ALLOWED_ORIGINS`、`LOG_LEVEL` |
| DeepSeek | `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_THINKING_ENABLED`、`DEEPSEEK_REASONING_EFFORT` |
| Agent | `DEFAULT_SYSTEM_PROMPT`、`CONTEXT_BUDGET_TOKENS`、`WEB_SEARCH_*`、`TAVILY_*` |
| Run Worker | `RUN_LEASE_SECONDS`、`WORKER_*`、`RUN_STREAM_*`、`DRAFT_CHECKPOINT_*` |
| Redis/Celery | `REDIS_URL`、`CELERY_BROKER_URL` |
| 邮件与认证 | `EMAIL_PROVIDER`、`EMAIL_*`、`POSTMARK_*`、`RESEND_*`、`AUTH_*` |
| 头像/R2 | `AVATAR_*`、`CLOUDFLARE_*` |

前端只有一个必需的构建变量：

```dotenv
VITE_API_BASE_URL=http://localhost:8000/api/v1
```

## 开发与验证

后端：

```bash
uv sync --all-groups
uv run alembic upgrade head
uv run ruff check .
uv run mypy app
uv run pytest
```

以上宿主机命令要求本地 `.env` 中的 PostgreSQL/Redis 地址使用 `localhost`，并且对应
Compose 基础服务已经启动；`.env.example` 中的 `postgres` 与 `redis` 是容器网络主机名。
若使用默认容器配置，数据库迁移已由 `docker compose up -d` 中的 `migrate` 服务执行。

前端（在 `frontend/` 目录）：

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
```

只启动单个后端进程时：

```bash
uv run uvicorn app.main:app --reload
uv run python -m app.worker
uv run celery -A app.tasks.celery_app worker --loglevel=info
uv run celery -A app.tasks.celery_app beat --loglevel=info
```

这些进程同样需要把连接地址改为宿主机可访问的 PostgreSQL/Redis 地址。

## 部署

- 后端由 `compose.prod.yml` 编排 PostgreSQL、Redis、API、流式 Worker、Celery、
  media worker、Beat 和 Nginx。
- 推送到 `main` 后，CI workflow 运行后端/前端检查；独立的 Deploy workflow 构建镜像、
  推送到 GHCR 并通过 SSH 更新服务器。当前部署 workflow 不以 CI 成功作为前置门禁。
- 前端由 Cloudflare Pages 构建 `frontend/`，生产输出为 `dist/`。
- 新增前端或预览域名时，必须同步更新后端 `CORS_ALLOWED_ORIGINS`，并重新创建 API
  容器以加载环境变量。

生产配置、迁移、证书和回滚步骤见[部署指南](docs/deployment.md)。

## 文档

- [文档索引](docs/README.md)
- [架构总览](docs/architecture/overview.md)
- [模块边界](docs/architecture/module-boundaries.md)
- [后台任务约定](docs/architecture/background-tasks.md)
- [Agent runtime 重构交接](docs/handover/2026-07-20-agent-runtime-refactor-04b-implementation.md)
- [部署指南](docs/deployment.md)
- [开发约定](AGENTS.md)
