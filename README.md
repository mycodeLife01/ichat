# iChat

基于 FastAPI 的 AI 聊天后端服务，集成 DeepSeek API，支持 SSE 实时流式响应。

## 核心特性

- **用户认证** — JWT 双 Token 方案（Access + Refresh），Argon2 密码哈希
- **对话管理** — 创建、列表、重命名、软删除，线性消息历史
- **流式响应** — SSE 事件推送，支持断线重连与事件重放
- **异步处理** — 基于 PostgreSQL 行锁的任务队列，租约 + 心跳保障容错
- **取消与重生成** — 运行中取消、从任意消息重新生成回复
- **Provider 抽象** — DeepSeek 适配器，可扩展支持其他 LLM

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.12、FastAPI、SQLAlchemy 2.0（async）、Alembic、PyJWT、pwdlib（Argon2）、httpx、loguru |
| 数据库 | PostgreSQL 16（asyncpg 驱动） |
| 前端 | Vanilla JS、Tailwind CSS、marked.js、DOMPurify |
| 部署 | Docker、Nginx、GitHub Actions CI/CD |
| 包管理 | uv |

## 快速开始

**前置要求：** Docker、Docker Compose、DeepSeek API Key

```bash
# 1. 克隆仓库
git clone <repo-url> && cd ichat

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 DEEPSEEK_API_KEY 和 JWT_SECRET

# 3. 启动所有服务（API + Worker + PostgreSQL）
docker compose up -d

# 4. 运行数据库迁移
docker compose exec api alembic upgrade head

# 5. 访问应用
# http://localhost:8000
```

## 项目结构

```
app/
├── api/v1/           # FastAPI 路由
│   ├── auth/         #   认证（注册、登录、刷新、登出）
│   ├── conversations/#   对话 CRUD + 发送消息
│   └── runs/         #   Run 状态查询、取消、SSE 事件流
├── services/         # 业务逻辑
├── models/           # SQLAlchemy ORM 模型
├── schemas/          # Pydantic 请求/响应模型
├── providers/        # LLM Provider 接口与适配器
├── context/          # 上下文拼装（系统提示词 + 消息历史裁剪）
├── worker/           # 后台 Worker（轮询、Claim、流处理）
├── core/             # 配置、日志、错误定义
├── db/               # 数据库连接与会话管理
└── main.py           # FastAPI 应用入口

frontend/             # 前端静态文件
deploy/               # Nginx 配置、SSL 证书
tests/                # 测试（镜像 app 目录结构）
alembic/              # 数据库迁移脚本
```

## 架构概览

```
客户端
  │
  ▼
Nginx (80/443)
  │
  ▼
FastAPI API (:8000)          Worker 进程
  │                            │
  ├── 写入消息 & 创建 Run ──► 轮询 & Claim Run
  │                            │
  ▼                            ▼
PostgreSQL (:5432)           DeepSeek API
  ▲                            │
  └── 持久化事件 ◄─────────── 流式响应
```

**关键设计：**
- HTTP 流不绑定 Run 生命周期 — 客户端可断线重连，通过 `after_seq` 游标重放事件
- 无 Redis/Celery — 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 实现分布式任务队列
- 租约 + 心跳机制 — Worker 崩溃后自动恢复孤立任务

## API 概览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/auth/register` | POST | 用户注册 |
| `/api/v1/auth/login` | POST | 用户登录，返回 Access + Refresh Token |
| `/api/v1/auth/refresh` | POST | 刷新 Access Token |
| `/api/v1/auth/logout` | POST | 登出，吊销 Refresh Token |
| `/api/v1/conversations` | GET | 获取对话列表 |
| `/api/v1/conversations` | POST | 创建对话 |
| `/api/v1/conversations/{id}` | GET | 获取对话详情（含消息） |
| `/api/v1/conversations/{id}` | PATCH | 重命名对话 |
| `/api/v1/conversations/{id}` | DELETE | 删除对话 |
| `/api/v1/conversations/{id}/messages` | POST | 发送消息（自动创建 Run） |
| `/api/v1/runs/{id}/state` | GET | 获取 Run 状态 |
| `/api/v1/runs/{id}/events` | GET | SSE 事件流 |
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
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | | `900` | Access Token 有效期（秒） |
| `REFRESH_TOKEN_TTL_SECONDS` | | `2592000` | Refresh Token 有效期（秒） |
| `DEEPSEEK_BASE_URL` | | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | | `deepseek-chat` | 使用的模型 |
| `DEEPSEEK_THINKING_ENABLED` | | `false` | 是否启用推理模式 |
| `DEFAULT_SYSTEM_PROMPT` | | `You are a helpful assistant.` | 系统提示词 |
| `RUN_LEASE_SECONDS` | | `60` | Run 租约有效期 |
| `WORKER_POLL_INTERVAL_SECONDS` | | `2` | Worker 轮询间隔 |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | | `10` | Worker 心跳间隔 |
| `LOG_LEVEL` | | `INFO` | 日志级别 |

完整示例见 [.env.example](.env.example)。

## 开发命令

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
mypy app                             # 类型检查

# 测试
pytest                                # 运行全部测试
pytest --cov=app                      # 测试覆盖率
```

## 部署

### 生产环境

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

### CI/CD

推送到 `main` 分支后，GitHub Actions 自动执行：
1. **CI** — Lint、类型检查、测试、构建 Docker 镜像
2. **部署** — 构建并推送镜像到 GHCR → SSH 到服务器 → 拉取、迁移、重启

详细部署指南见 [docs/deployment.md](docs/deployment.md)。

## 相关文档

- [部署指南](docs/deployment.md)
- [模块边界](docs/architecture/module-boundaries.md)
- [开发约定](CLAUDE.md)
