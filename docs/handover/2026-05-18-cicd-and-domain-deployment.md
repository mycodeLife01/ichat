# 2026-05-18 CI/CD 流水线与域名部署 交接

## 本次完成

- 搭建 GitHub Actions CI/CD 流水线：
  - CI workflow（`.github/workflows/ci.yml`）：push/PR 到 `main` 时自动执行 ruff lint → mypy 类型检查 → alembic 迁移 → pytest 测试 → Docker 镜像构建验证。
  - Deploy workflow（`.github/workflows/deploy.yml`）：push 到 `main` 后自动构建镜像、推送到 ghcr.io、SSH 部署到服务器。
- 创建生产环境 Docker Compose 配置（`compose.prod.yml`）：
  - PostgreSQL（持久化数据卷）、API（uvicorn）、Worker、Nginx 反向代理、Alembic 迁移容器（profiles: migrate）。
  - 镜像统一使用 `ghcr.io/mycodelife01/ichat:latest`。
- 配置 Nginx 反向代理（`deploy/nginx.conf`）：
  - HTTPS（端口 8443）+ HTTP→HTTPS 自动跳转。
  - 使用 Docker 内置 DNS resolver（`127.0.0.11`）+ 变量方式延迟解析，避免 Nginx 在 API 容器未就绪时启动失败。
  - SSE 支持：关闭 proxy_buffering / proxy_cache，read_timeout 300s。
- 域名与 HTTPS 配置：
  - 域名 `feslia.com` 通过 Cloudflare 注册，DNS 指向服务器。
  - 使用 Cloudflare Origin Certificate（15 年有效期）实现端到端加密。
  - 因服务器 443 端口被占用，Nginx 监听 8443，通过 Cloudflare Origin Rule 指定回源端口。
  - Cloudflare SSL 模式：Full (Strict)。

## 最终架构

```
用户 → HTTPS(:443) → Cloudflare CDN → HTTPS(:8443) → Nginx → HTTP → API(:8000)
                                                                    → Worker
                                                                    → PostgreSQL
```

## CI/CD 流程

```
git push origin main
  → CI: lint → type check → migrate → test → build image
  → Deploy: build → push ghcr.io → SSH → pull → migrate → up -d
```

## 新增文件

| 文件 | 用途 |
|------|------|
| `.github/workflows/ci.yml` | CI 流水线 |
| `.github/workflows/deploy.yml` | 自动部署流水线 |
| `compose.prod.yml` | 生产环境 Docker Compose |
| `deploy/nginx.conf` | Nginx 反向代理配置 |
| `docs/deployment.md` | 部署操作文档 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `.gitignore` | 添加 `deploy/certs/` |

## 服务器文件布局

```
/opt/ichat/
├── compose.prod.yml
├── deploy/
│   ├── nginx.conf
│   └── certs/
│       ├── fullchain.pem   (Cloudflare Origin Certificate)
│       └── privkey.pem     (Private Key)
└── .env                    (生产环境变量)
```

## GitHub Secrets 配置

| Secret | 用途 |
|--------|------|
| `DEPLOY_HOST` | 服务器 IP |
| `DEPLOY_USER` | SSH 用户名 |
| `DEPLOY_SSH_KEY` | SSH 私钥（ed25519） |
| `DEPLOY_PATH` | 部署目录 `/opt/ichat` |

## CI 调试过程中修复的问题

1. pytest 前未执行 `alembic upgrade head` 导致表不存在 → 添加迁移步骤。
2. alembic `env.py` 加载 `Settings()` 需要全部环境变量 → 将环境变量提升到 job 级别。
3. CI 环境变量 `DEEPSEEK_MODEL=deepseek-chat` 与测试 fixture `deepseek-test` 不匹配 → 改为 `deepseek-test`。
4. Nginx `upstream` 块在启动时硬解析 DNS，API 未就绪则崩溃 → 改用 `resolver` + `set $backend` 变量延迟解析。
5. 服务器 443 端口被占用 → Nginx 改用 8443，Cloudflare Origin Rule 指定回源端口。

## 注意事项

- 服务器配置文件（`compose.prod.yml`、`nginx.conf`）为手动放置，代码变更后需手动同步到服务器。
- `deploy/certs/` 已在 `.gitignore` 中，证书不入仓库。
- 原有 `compose.yml` 保持不变，仅用于本地开发。
