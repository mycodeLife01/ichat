# 部署指南

## 架构概览

```
浏览器 ── 前端 React SPA（Cloudflare Pages，chat.feslia.com）
                │
                │ 跨域 API 调用（CORS）
                ▼
用户 → Nginx (80/8443) → FastAPI API (8000) → PostgreSQL (5432)
                                            → Worker (LLM run)
                                            → Redis (Run Stream / 唤醒 / Celery / 限流)
                                            → Celery Worker / Beat (邮件、标题、维护任务)
                                            → Media Worker → Cloudflare R2 / CDN purge (头像)
                                            → File Worker → ClamAV → 私有 Cloudflare R2 (消息附件)
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
- `deploy/clamav/entrypoint.sh`
- `deploy/clamav/healthcheck.sh`
- `.env`（基于 `.env.example` 修改）

```bash
# 从本地复制（在本地执行）
scp compose.prod.yml deploy/nginx.conf user@your-server:/opt/ichat/
scp -r deploy/clamav user@your-server:/opt/ichat/deploy/
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

# Web Search（可选，默认关闭）
WEB_SEARCH_ENABLED=false
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=<启用时填写 Tavily API Key>
TAVILY_BASE_URL=https://api.tavily.com

# 自动标题
SUMMARY_PROVIDER_NAME=deepseek
SUMMARY_MODEL=deepseek-chat

# CORS —— 前端域名，逗号分隔精确 origin；空 = 全部拒绝
CORS_ALLOWED_ORIGINS=https://chat.feslia.com

# Redis：Run Stream / runs_queued 唤醒 / Celery / 认证限流
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/0
RUN_STREAM_MAXLEN=2048
RUN_STREAM_TTL_SECONDS=600
RUN_STREAM_ORPHAN_TTL_SECONDS=86400
DRAFT_CHECKPOINT_INTERVAL_SECONDS=3.0
DRAFT_CHECKPOINT_MAX_PENDING_CHARS=4096
FRONTEND_APP_URL=https://chat.feslia.com
EMAIL_PROVIDER=postmark            # 生产用 postmark；dev/CI 用 console/fake
EMAIL_FROM=iChat <no-reply@mail.feslia.com>
POSTMARK_SERVER_TOKEN=<Postmark Server API Token>
POSTMARK_MESSAGE_STREAM=outbound

# 其他
# 系统提示词的可选覆盖；留空使用 app/prompts/ 内置生产提示词
DEFAULT_SYSTEM_PROMPT=
RUN_LEASE_SECONDS=60
WORKER_POLL_INTERVAL_SECONDS=30
WORKER_HEARTBEAT_INTERVAL_SECONDS=10
LOG_LEVEL=INFO
```

完整变量列表（含 Worker 并发、DB 连接池、Run Stream/checkpoint、Web Search 超时和证据压缩等调优项）见 `.env.example`。

头像 R2 的历史 expand 路径见 `docs/handover/2026-07-14-r2-avatar-upload.md`。统一 files 领域（消息附件、新头像写入、R2/ClamAV smoke、灰度、回滚与 ticket 15 contract 前置条件）以 `docs/handover/2026-08-01-unified-file-upload.md` 为当前权威。生产资源配置完成前保持 `AVATAR_STORAGE_ENABLED=false` 和 `FILE_UPLOAD_ENABLED=false`；旧头像兼容路径不能因此被提前删除。

### 文件上传与 ClamAV 配置

文件附件使用**三个私有** R2 bucket：staging（浏览器仅向随机 key PUT）、canonical（原件/文档派生物）与独立 preview（模型可见的安全图片派生物）。它们必须与头像公开 bucket 以及彼此分开，开发与生产也必须分开。`.env.example` 是完整变量清单；生产至少配置：

```env
FILE_UPLOAD_ENABLED=false
FILES_R2_ENDPOINT_URL=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
FILES_R2_REGION=auto
FILES_STAGING_BUCKET=ichat-prod-file-staging
FILES_CANONICAL_BUCKET=ichat-prod-files
FILES_PREVIEW_BUCKET=ichat-prod-file-previews

# API signer：仅 staging PUT/HEAD 与 canonical 短期 GET。
FILES_UPLOAD_ACCESS_KEY_ID=<upload-signer-key>
FILES_UPLOAD_SECRET_ACCESS_KEY=<upload-signer-secret>
FILES_DOWNLOAD_ACCESS_KEY_ID=<download-signer-key>
FILES_DOWNLOAD_SECRET_ACCESS_KEY=<download-signer-secret>

# API preview signer：仅 preview 短期 GET。
FILES_PREVIEW_API_ACCESS_KEY_ID=<preview-api-key>
FILES_PREVIEW_API_SECRET_ACCESS_KEY=<preview-api-secret>

# LLM Worker：仅 preview 短期 GET，不能读取 canonical 原件。
FILES_PREVIEW_LLM_ACCESS_KEY_ID=<preview-llm-key>
FILES_PREVIEW_LLM_SECRET_ACCESS_KEY=<preview-llm-secret>

# 仅 file-worker 接收：staging 条件 GET/delete、canonical 与 preview 写入/delete/迁移。
FILES_WORKER_ACCESS_KEY_ID=<file-worker-key>
FILES_WORKER_SECRET_ACCESS_KEY=<file-worker-secret>

CLAMAV_HOST=clamav
CLAMAV_PORT=3310
CLAMAV_SIGNATURE_MAX_AGE_SECONDS=172800
```

ClamAV 容器通过仓库内的启动脚本先同步执行一次 `freshclam`，成功或重试耗尽后才启动
clamd，避免持久卷中的旧病毒库与 clamd 并发加载。健康检查同时比较 clamd 内存版本与
磁盘版本，并按 `CLAMAV_SIGNATURE_MAX_AGE_SECONDS` 校验签名时间；仅能响应 `PING` 或
普通扫描不足以进入 healthy。`file-worker` 继续依赖该健康状态启动，因此不能删除
`deploy/clamav` 脚本挂载，也不能把健康检查退回单纯的 `clamdscan --ping`。

compose 的环境覆盖是安全边界的一部分：API 会清空 file-worker 与 preview LLM 凭证；普通 LLM worker 只保留 preview LLM 读凭证并显式清空 staging/canonical 配置及其他 files 凭证；邮件/标题 worker、media-worker 和 beat 清空全部五组 files 凭证；file-worker 不使用通用 `env_file`，固定 `FILE_UPLOAD_ENABLED=false`，只持有自己的 worker 凭证、三个私有 bucket、PG/broker 和 ClamAV 连接。这里的 `false` 只代表它不创建 API 上传会话，**不会**阻止它按 PostgreSQL 事实排空已有上传、preview backfill、回收或删除补偿。

`media-worker` 只持有头像公开对象和 CDN purge 所需凭证，不能获得 files staging/canonical/preview 凭证；file-worker 反之不能获得头像公开 bucket、purge、邮件或 LLM Secret。不要为了简化 Compose 将这两个服务改回共享 `.env`。精确 R2 CORS、ETag/If-Match、ClamAV EICAR（不落盘）smoke 与权限核对命令见[统一文件上传交接](handover/2026-08-01-unified-file-upload.md)；视觉白名单、preview backfill、真实 GPT/R2 smoke 与回滚见[GPT 图片输入交接](handover/2026-08-03-gpt-vision-input.md)。

`FILE_UPLOAD_ENABLED` 只控制新附件创建：关闭后 `/capabilities` 要求前端隐藏入口，API 拒绝新会话；已有附件仍可展示/读取，files queue 仍排空，维护与删除补偿仍运行。切换该开关必须 force-recreate API；生产回滚顺序见该交接，不能先停 worker 或撤销凭证。

> **注意**：修改 `.env` 中的 `CORS_ALLOWED_ORIGINS` 后，必须 `docker compose -f compose.prod.yml up -d --force-recreate api` 才会生效——`restart` 不会重新加载 env。

> **Web Search**：后端通过 `GET /api/v1/capabilities` 对前端公开联网搜索是否可用；只有 `WEB_SEARCH_ENABLED=true` 且 `TAVILY_API_KEY` 非空时返回 enabled。修改 `WEB_SEARCH_ENABLED`、`TAVILY_API_KEY` 或相关超时/额度配置后，需至少 force-recreate `api` 和 `worker` 容器，让 capabilities 与 worker runtime 同步加载新 env。

> **Redis / Celery**：`compose.prod.yml` 显式使用 `maxmemory-policy noeviction`；不得改为会驱逐 key 的策略，否则 Celery broker 与 Run Stream 都可能丢数据。`celery-beat` 必须**单实例**。修改 Run Stream/checkpoint env 后须 force-recreate `api worker`；修改标题 provider/model 或邮件 env 后须 force-recreate `celery-worker`（邮件调度还涉及 `celery-beat`）。Postmark DNS/DKIM/SPF、dead outbox、以及 nginx Cloudflare realip + 源站防火墙清单详见 `docs/handover/2026-06-26-email-verification.md`。

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

# 启动所有服务（含 clamav 与 file-worker）
docker compose -f compose.prod.yml up -d

# 查看日志
docker compose -f compose.prod.yml logs -f
```

## 三、CI/CD 自动部署

### GitHub Actions 配置

项目已包含两个 workflow：

- **CI** (`.github/workflows/ci.yml`)：每次 push/PR 到 `main` 时运行 lint、类型检查、测试和镜像构建
- **Deploy** (`.github/workflows/deploy.yml`)：push 到 `main` 后自动构建镜像并部署到服务器

Deploy job 会检出触发工作流的提交，先把该提交中的 `compose.prod.yml`、
`deploy/nginx.conf` 与 `deploy/clamav/` 启动/健康脚本同步到 `DEPLOY_PATH`，同步成功后才
通过 SSH 执行镜像拉取、迁移和 `up -d --remove-orphans`。生产部署按工作流串行执行，避免
并发提交覆盖彼此的部署定义；最后会强制重建 nginx，使刚同步的 real-IP 配置立即生效。
任一步失败都会终止部署，不会继续使用服务器上的旧拓扑。

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
docker compose -f compose.prod.yml logs -f file-worker
docker compose -f compose.prod.yml logs -f clamav

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
│          → 同步 Compose/nginx       └─
│          → SSH deploy）
│      ↓
│  服务器执行:
│      docker compose --profile migrate pull
│      docker compose run --rm migrate
│      docker compose up -d
│      docker compose up -d --force-recreate nginx
└─
```

推送到 `main` 分支后，前后端两条流水线各自全自动完成。
