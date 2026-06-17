# iChat

AI 聊天应用：FastAPI 后端集成 DeepSeek API，支持 SSE 实时流式响应；前端为独立 React SPA，部署于 Cloudflare Pages。

## 核心特性

- **用户认证** — JWT 双 Token 方案（Access + Refresh），Argon2 密码哈希
- **对话管理** — 创建、列表、重命名、软删除，线性消息历史
- **草稿对话** — 新建对话仅在首次成功回复后激活并进入侧栏列表
- **自动标题** — 首个 succeeded run 后异步生成对话标题（best-effort，失败不影响主流程）
- **流式响应** — SSE 事件推送，支持 `after_seq` 游标断线重连与事件重放
- **编辑与重生成** — 编辑用户消息或从任意助手回复重新生成
- **取消运行** — 运行中可随时取消，partial 进度保留
- **并发架构** — 单 Worker 内 `asyncio.Semaphore` 并发执行多个 Run，支持多 Worker 副本
- **PG 推送机制** — Claim 与 SSE 双端均通过 PostgreSQL `LISTEN/NOTIFY` 推送，poll 仅作兜底
- **Provider 抽象** — DeepSeek 适配器，可扩展支持其他 LLM

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.12、FastAPI、SQLAlchemy 2.0（async）、Alembic、PyJWT、pwdlib（Argon2）、httpx、loguru |
| 数据库 | PostgreSQL 16（asyncpg 驱动） |
| 前端 | React 19、TypeScript、Vite、Tailwind CSS v4、Vitest + Testing Library + MSW、pnpm |
| 部署 | 后端：Docker、Nginx、GitHub Actions CI/CD；前端：Cloudflare Pages |
| 包管理 | 后端 uv / 前端 pnpm |

## 快速开始

**前置要求：** Docker、Docker Compose、DeepSeek API Key；前端开发另需 Node.js 22+ 与 pnpm

```bash
# 1. 克隆仓库
git clone <repo-url> && cd ichat

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 DEEPSEEK_API_KEY 和 JWT_SECRET
# CORS_ALLOWED_ORIGINS 默认已放行本地 Vite dev server（http://localhost:5173）

# 3. 启动后端服务（API + Worker + PostgreSQL）
docker compose up -d

# 4. 运行数据库迁移
docker compose exec api alembic upgrade head

# 5. 启动前端 dev server
cd frontend
echo "VITE_API_BASE_URL=http://localhost:8000/api/v1" > .env
pnpm install
pnpm dev

# 6. 访问应用
# http://localhost:5173
```

后端为纯 API 服务（`/api/v1/*`、`/healthz`、`/readyz`），不再托管前端静态文件。前端必须通过 `VITE_API_BASE_URL`（构建时注入）指定 API 地址。

## 项目结构

```
app/
├── api/v1/           # FastAPI 路由
│   ├── auth.py       #   认证（注册、登录、刷新、登出）
│   ├── conversations.py  # 对话 CRUD + 发送消息 + 编辑/重生成
│   └── runs.py       #   Run 状态查询、取消、SSE 事件流
├── services/         # 业务逻辑
│   ├── auth/         #   认证服务与依赖
│   ├── conversations/#   对话与消息逻辑
│   ├── runs/         #   Run 生命周期与状态机
│   └── run_events/   #   SSE 订阅管理（LISTEN/NOTIFY fan-out）
├── models/           # SQLAlchemy ORM 模型
├── schemas/          # Pydantic 请求/响应模型
├── providers/        # LLM Provider 接口与适配器（含 summarize）
├── context/          # 上下文拼装（系统提示词 + 消息历史裁剪）
├── worker/           # 后台 Worker（轮询、Claim、流处理、标题生成）
├── core/             # 配置、日志、错误定义
├── db/               # 数据库连接与会话管理
└── main.py           # FastAPI 应用入口

frontend/             # React SPA（Vite + TypeScript + Tailwind v4，部署于 Cloudflare Pages）
├── src/api/          #   API 客户端、SSE 解析、错误类型
├── src/app/          #   应用壳、Provider、reducer store
├── src/auth/         #   认证页与会话管理
├── src/conversations/#   会话列表与详情加载
├── src/runs/         #   Run 流式 hook、刷新恢复、取消
├── src/messages/     #   消息线程渲染
├── src/ui/           #   共享组件（Toast、BottomSheet、Composer 等）
└── src/styles/       #   global.css（Tailwind @theme + 白名单自定义规则）

deploy/               # Nginx 配置
tests/                # 后端测试（镜像 app 目录结构；前端测试与源码同目录）
alembic/              # 数据库迁移脚本
```

## 架构概览

```
浏览器 ── React SPA（Cloudflare Pages, chat.feslia.com）
  │
  │ 跨域 API 调用（CORS）
  ▼
Nginx (80/8443, feslia.com)
  │
  ▼
FastAPI API (:8000)          Worker 进程（可多副本）
  │                            │
  ├── 写消息 / 创建 Run ──► LISTEN runs_new → Claim
  │                            │
  │                            ├── 内部 Semaphore 并发（默认 8）
  │                            │
  │   ◄── LISTEN run_events ── 流式响应 + Delta 批量持久化
  ▼                            ▼
PostgreSQL (:5432)           DeepSeek API
```

**关键设计：**
- 前后端完全解耦 — 前端是独立 SPA，经 CORS 跨域调用 API；后端不托管任何静态文件
- HTTP 流不绑定 Run 生命周期 — 客户端可断线重连，通过 `after_seq` 游标重放事件
- 无 Redis/Celery — 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 实现分布式任务队列
- 租约 + 心跳机制 — Worker 崩溃后自动恢复孤立任务
- 双端 LISTEN/NOTIFY — Claim 与 SSE 均由 PG 推送驱动，poll 仅为兜底安全网
- Delta 批量化 — 时间窗口（默认 50ms）或字符阈值（默认 256）触发 flush，降低小事务数

## API 概览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/auth/register` | POST | 用户注册 |
| `/api/v1/auth/login` | POST | 用户登录，返回 Access + Refresh Token |
| `/api/v1/auth/refresh` | POST | 刷新 Access Token |
| `/api/v1/auth/logout` | POST | 登出，吊销 Refresh Token |
| `/api/v1/conversations` | GET | 获取对话列表（仅已激活） |
| `/api/v1/conversations` | POST | 创建对话（草稿，首次成功 run 后激活） |
| `/api/v1/conversations/{id}` | GET | 获取对话详情（含消息，允许访问草稿） |
| `/api/v1/conversations/{id}` | PATCH | 重命名对话 |
| `/api/v1/conversations/{id}` | DELETE | 删除对话 |
| `/api/v1/conversations/{id}/messages` | POST | 发送消息（自动创建 Run） |
| `/api/v1/conversations/{id}/messages/{msg_id}/edit-and-regenerate` | POST | 编辑用户消息后重新生成 |
| `/api/v1/conversations/{id}/messages/{msg_id}/regenerate` | POST | 从指定助手消息处重新生成 |
| `/api/v1/runs/{id}/state` | GET | 获取 Run 状态 |
| `/api/v1/runs/{id}/events` | GET | SSE 事件流（支持 `after_seq` 游标） |
| `/api/v1/runs/{id}/cancel` | POST | 取消 Run |
| `/healthz` | GET | 存活检查 |
| `/readyz` | GET | 就绪检查（含数据库连通性） |

启动后访问 `/docs` 查看完整 Swagger 文档。

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|:----:|--------|------|
| `DATABASE_URL` | ✓ | — | PostgreSQL 异步连接字符串 |
| `JWT_SECRET` | ✓ | — | JWT 签名密钥 |
| `DEEPSEEK_API_KEY` | ✓ | — | DeepSeek API 密钥 |
| `SUMMARY_PROVIDER_NAME` | ✓ | — | 自动标题使用的 Provider 名称（如 `deepseek`） |
| `SUMMARY_MODEL` | ✓ | — | 自动标题使用的模型 |
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | | `900` | Access Token 有效期（秒） |
| `REFRESH_TOKEN_TTL_SECONDS` | | `2592000` | Refresh Token 有效期（秒） |
| `DEEPSEEK_BASE_URL` | | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | | `deepseek-chat` | 使用的模型 |
| `DEEPSEEK_THINKING_ENABLED` | | `false` | 是否启用推理模式 |
| `DEFAULT_SYSTEM_PROMPT` | | `（空）` | 系统提示词的可选覆盖；留空则使用 `app/prompts/` 内置生产提示词 |
| `RUN_LEASE_SECONDS` | | `60` | Run 租约有效期 |
| `WORKER_POLL_INTERVAL_SECONDS` | | `30` | Worker 兜底轮询间隔（主要靠 LISTEN/NOTIFY） |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | | `10` | Worker 心跳间隔 |
| `WORKER_MAX_INFLIGHT_RUNS` | | `8` | 单 Worker 进程内并发执行的 Run 上限 |
| `WORKER_DELTA_BATCH_WINDOW_MS` | | `50` | Delta 批量化时间窗口（毫秒） |
| `WORKER_DELTA_BATCH_MAX_CHARS` | | `256` | Delta 批量化字符阈值 |
| `DB_POOL_SIZE` | | `20` | SQLAlchemy 连接池大小 |
| `DB_MAX_OVERFLOW` | | `20` | 连接池溢出上限 |
| `DB_POOL_TIMEOUT_SECONDS` | | `30` | 获取连接超时 |
| `SSE_FALLBACK_INTERVAL_SECONDS` | | `5.0` | SSE 端 LISTEN/NOTIFY 兜底轮询间隔 |
| `AUTO_TITLE_ENABLED` | | `true` | 是否启用自动标题生成 |
| `AUTO_TITLE_MAX_CHARS` | | `32` | 自动标题最大字符数 |
| `AUTO_TITLE_MAX_OUTPUT_TOKENS` | | `40` | 自动标题模型输出 token 上限 |
| `CORS_ALLOWED_ORIGINS` | | `""` | 允许跨域的前端 origin（逗号分隔，空 = 全部拒绝；生产必须显式配置） |
| `LOG_LEVEL` | | `INFO` | 日志级别 |

完整示例见 [.env.example](.env.example)。

前端构建变量（Vite 构建时注入，修改后需重新构建）：

| 变量 | 必需 | 说明 |
|------|:----:|------|
| `VITE_API_BASE_URL` | ✓ | 后端 API 基地址，如 `https://feslia.com/api/v1`（本地开发 `http://localhost:8000/api/v1`） |

## 开发命令

### 后端

```bash
# 依赖安装
uv sync                              # 生产依赖
uv sync --all-groups                  # 含开发依赖

# 本地开发
docker compose up -d                  # 启动所有服务
uvicorn app.main:app --reload         # 单独启动 API（需本地 PostgreSQL）
python -m app.worker                  # 单独启动 Worker

# 数据库迁移
alembic upgrade head                  # 执行迁移
alembic revision --autogenerate -m "" # 生成新迁移脚本

# 代码质量
ruff check app tests                  # Lint
mypy app                              # 类型检查

# 测试
pytest                                # 运行全部测试
pytest --cov=app                      # 测试覆盖率
```

### 前端（在 `frontend/` 目录下，使用 pnpm）

```bash
pnpm install                          # 安装依赖
pnpm dev                              # Vite dev server（:5173）
pnpm exec vitest run                  # 运行测试
pnpm run lint                         # ESLint
pnpm run typecheck                    # TypeScript 类型检查
pnpm run build                        # 生产构建（tsc -b && vite build → dist/）
```

## 部署

### 后端（服务器 + Docker Compose）

```bash
# 1. 在服务器上准备配置
mkdir -p /opt/ichat && cd /opt/ichat
# 上传 compose.prod.yml、deploy/nginx.conf、.env
# 放置 SSL 证书到 deploy/certs/

# 2. 拉取镜像 & 迁移 & 启动
docker compose -f compose.prod.yml pull
docker compose -f compose.prod.yml run --rm migrate
docker compose -f compose.prod.yml up -d
```

### 前端（Cloudflare Pages）

前端由 Cloudflare Pages 托管（生产域名 `chat.feslia.com`），与本仓库 Git 集成：

- 生产分支 `main`，根目录 `frontend`，构建命令 `pnpm build`，输出目录 `dist`
- 构建变量 `VITE_API_BASE_URL=https://feslia.com/api/v1`
- 非 `main` 分支 push 自动生成预览部署（分支别名域名固定）
- 新增前端域名/预览域名后，需同步加入后端 `CORS_ALLOWED_ORIGINS` 并 force-recreate api 容器

### CI/CD

推送到 `main` 分支后自动执行：
1. **CI**（GitHub Actions）— 后端 lint、类型检查、测试、镜像构建；前端 lint、类型检查、测试、构建
2. **后端部署**（GitHub Actions）— 构建并推送镜像到 GHCR → SSH 到服务器 → 拉取、迁移、重启
3. **前端部署**（Cloudflare Pages）— Pages 检测到 push 自动构建并发布

详细部署指南见 [docs/deployment.md](docs/deployment.md)。

## 相关文档

- [部署指南](docs/deployment.md)
- [架构概览](docs/architecture/overview.md)
- [模块边界](docs/architecture/module-boundaries.md)
- [开发约定](CLAUDE.md)
