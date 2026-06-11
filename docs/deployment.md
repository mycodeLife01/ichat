# 部署指南

## 架构概览

```
浏览器 ── 前端 React SPA（Cloudflare Pages，chat.feslia.com）
                │
                │ 跨域 API 调用（CORS）
                ▼
用户 → Nginx (80/8443) → FastAPI API (8000) → PostgreSQL (5432)
                                            → Worker (后台任务)
```

部署分两条线：

- **后端**：Linux 服务器 + Docker Compose（本文第一至四节）
- **前端**：Cloudflare Pages，与 Git 仓库集成自动构建（本文第五节）

后端为纯 API 服务，不托管前端静态文件。

## 前置条件

- Linux 服务器（Ubuntu 22.04+ 推荐）
- Docker Engine 24+ 和 Docker Compose V2
- 一个指向服务器 IP 的域名（如需 HTTPS）

## 一、服务器初始化

### 1. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登录使 docker 组生效
```

### 2. 创建部署目录

```bash
sudo mkdir -p /opt/ichat
sudo chown $USER:$USER /opt/ichat
cd /opt/ichat
```

### 3. 上传配置文件

将以下文件复制到服务器 `/opt/ichat/` 目录：

- `compose.prod.yml`
- `deploy/nginx.conf`
- `.env`（基于 `.env.example` 修改）

```bash
# 从本地复制（在本地执行）
scp compose.prod.yml deploy/nginx.conf user@your-server:/opt/ichat/
scp .env.example user@your-server:/opt/ichat/.env
```

### 4. 配置环境变量

在服务器上编辑 `/opt/ichat/.env`：

```bash
# 数据库 —— 务必修改密码
POSTGRES_USER=ichat
POSTGRES_PASSWORD=<强密码>
POSTGRES_DB=ichat

# 数据库连接（密码需与上方一致）
DATABASE_URL=postgresql+asyncpg://ichat:<强密码>@postgres:5432/ichat

# JWT —— 务必修改
JWT_SECRET=<随机字符串，建议 openssl rand -hex 32 生成>
JWT_ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000

# DeepSeek API
DEEPSEEK_API_KEY=<你的真实 API Key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_THINKING_ENABLED=false

# 自动标题
SUMMARY_PROVIDER_NAME=deepseek
SUMMARY_MODEL=deepseek-chat

# CORS —— 前端域名，逗号分隔精确 origin；空 = 全部拒绝
CORS_ALLOWED_ORIGINS=https://chat.feslia.com

# 其他
DEFAULT_SYSTEM_PROMPT=You are a helpful assistant.
RUN_LEASE_SECONDS=60
WORKER_POLL_INTERVAL_SECONDS=30
WORKER_HEARTBEAT_INTERVAL_SECONDS=10
LOG_LEVEL=INFO
```

完整变量列表（含 Worker 并发、DB 连接池、SSE 等调优项）见 `.env.example`。

> **注意**：修改 `.env` 中的 `CORS_ALLOWED_ORIGINS` 后，必须 `docker compose -f compose.prod.yml up -d --force-recreate api` 才会生效——`restart` 不会重新加载 env。

### 5. 创建证书目录（可选，HTTPS 用）

```bash
mkdir -p /opt/ichat/deploy/certs
# 将 fullchain.pem 和 privkey.pem 放入该目录
# 然后取消 deploy/nginx.conf 中 HTTPS 部分的注释
```

## 二、手动部署

```bash
cd /opt/ichat

# 登录 GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u <你的GitHub用户名> --password-stdin

# 拉取镜像
docker compose -f compose.prod.yml pull

# 运行数据库迁移
docker compose -f compose.prod.yml run --rm migrate

# 启动所有服务
docker compose -f compose.prod.yml up -d

# 查看日志
docker compose -f compose.prod.yml logs -f
```

## 三、CI/CD 自动部署

### GitHub Actions 配置

项目已包含两个 workflow：

- **CI** (`.github/workflows/ci.yml`)：每次 push/PR 到 `main` 时运行 lint、类型检查、测试和镜像构建
- **Deploy** (`.github/workflows/deploy.yml`)：push 到 `main` 后自动构建镜像并部署到服务器

### 配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 中添加以下 secrets：

| Secret 名称 | 说明 |
|---|---|
| `DEPLOY_HOST` | 服务器 IP 或域名 |
| `DEPLOY_USER` | SSH 用户名 |
| `DEPLOY_SSH_KEY` | SSH 私钥（`ssh-keygen -t ed25519` 生成） |
| `DEPLOY_PATH` | 部署目录，如 `/opt/ichat` |

### 配置 GitHub Environment

在仓库 Settings → Environments 中创建 `production` 环境（可选添加审批保护）。

### SSH 密钥配置

```bash
# 本地生成密钥对
ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key

# 将公钥添加到服务器
ssh-copy-id -i deploy_key.pub user@your-server

# 将私钥内容复制到 GitHub Secret DEPLOY_SSH_KEY
cat deploy_key
```

## 四、前端部署（Cloudflare Pages）

前端不在服务器上部署，由 Cloudflare Pages 托管并与 Git 仓库集成。

### Pages 项目配置

| 配置项 | 值 |
|---|---|
| 生产分支 | `main` |
| 根目录 | `frontend` |
| 构建命令 | `pnpm build` |
| 输出目录 | `dist` |
| 构建变量 | `VITE_API_BASE_URL=https://feslia.com/api/v1` |

- 生产域名：`https://chat.feslia.com`（自定义域），另有 `ichat-arr.pages.dev` 默认域。
- `VITE_API_BASE_URL` 为**构建时注入**，修改后需触发重新构建才生效。
- 非 `main` 分支 push 会自动生成预览部署，分支别名域名固定（如 `<branch>.ichat-arr.pages.dev`）。

### CORS 联动

前端跨域调用后端 API，后端通过 `CORS_ALLOWED_ORIGINS`（服务器 `/opt/ichat/.env`）按精确 origin 放行：

```bash
CORS_ALLOWED_ORIGINS=https://chat.feslia.com,https://ichat-arr.pages.dev
```

新增前端域名或需要联调的预览域名时：

```bash
# 1. 编辑 /opt/ichat/.env，追加 origin
# 2. force-recreate api 容器（restart 不会重载 env）
docker compose -f compose.prod.yml up -d --force-recreate api
```

## 五、运维命令

```bash
cd /opt/ichat

# 查看服务状态
docker compose -f compose.prod.yml ps

# 查看日志
docker compose -f compose.prod.yml logs -f api
docker compose -f compose.prod.yml logs -f worker

# 重启单个服务
docker compose -f compose.prod.yml restart api

# 停止所有服务
docker compose -f compose.prod.yml down

# 停止并删除数据卷（⚠️ 会清除数据库数据）
docker compose -f compose.prod.yml down -v

# 数据库备份
docker compose -f compose.prod.yml exec postgres pg_dump -U ichat ichat > backup_$(date +%Y%m%d).sql

# 数据库恢复
docker compose -f compose.prod.yml exec -T postgres psql -U ichat ichat < backup_20260517.sql
```

## 六、部署流程总结

```
git push origin main
    ↓
┌─ 后端（GitHub Actions）              ┌─ 前端（Cloudflare Pages）
│  CI（lint → mypy → pytest → build） │  检测到 push 自动构建
│      ↓                              │  pnpm build → 发布到
│  Deploy（build → push ghcr.io       │  chat.feslia.com
│          → SSH deploy）             └─
│      ↓
│  服务器执行:
│      docker compose pull
│      docker compose run --rm migrate
│      docker compose up -d
└─
```

推送到 `main` 分支后，前后端两条流水线各自全自动完成。
