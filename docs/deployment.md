# 部署指南

## 架构概览

```
用户 → Nginx (80/443) → FastAPI API (8000) → PostgreSQL (5432)
                                            → Worker (后台任务)
```

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

# 其他
DEFAULT_SYSTEM_PROMPT=You are a helpful assistant.
RUN_LEASE_SECONDS=60
WORKER_POLL_INTERVAL_SECONDS=2
WORKER_HEARTBEAT_INTERVAL_SECONDS=10
LOG_LEVEL=INFO
```

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

## 四、运维命令

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

## 五、部署流程总结

```
git push origin main
    ↓
GitHub Actions CI（lint → mypy → pytest → build）
    ↓
GitHub Actions Deploy（build → push to ghcr.io → SSH deploy）
    ↓
服务器执行:
    docker compose pull
    docker compose run --rm migrate
    docker compose up -d
```

推送到 `main` 分支后，整个流程全自动完成。
