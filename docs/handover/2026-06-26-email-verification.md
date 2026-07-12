# 邮箱验证与认证邮件基础设施（交接）

日期：2026-06-26
分支：`feat/email-verification`
设计来源：`docs/superpowers/specs/2026-06-21-email-verification-design.md`

## 概述

补齐生产可恢复的邮箱验证流程，并打好后续认证类邮件（密码重置 / 注销确认）的基础：

- 注册后自动签发邮箱验证 token 并异步发送验证邮件。
- 登录用户可重发验证邮件，带用户/邮箱 cooldown 与 IP 限流。
- 公开验证链接 `/verify-email?token=...`，成功后置 `users.email_verified=true`。
- 新增 `GET /api/v1/auth/me` 供前端刷新当前 user。
- 未验证用户**不受限**使用产品，前端持续提示并提供重发入口。

token 从专用表升级为通用 `auth_tokens`（按 `purpose` 区分，本期只实现 `email_verification`）；邮件以 PostgreSQL `email_outbox` 为事实源，Redis + Celery 作异步执行通道。

## 数据模型

迁移 `alembic/versions/20260621_0008_email_verification_infra.py`：

- **drop** 旧表 `email_verification_tokens`（旧 token 语义不保留，作废生产中所有未验证 token，用户重发即可）。
- **create** `auth_tokens`：`purpose` / `token_hash`(SHA-256, String(64), unique) / `sent_to_email` / `expires_at` / `used_at` / `revoked_at`。含 partial unique index `(user_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL`（兜底「同一用途仅一个 active token」）。
- **create** `email_outbox`：`status`(pending/sending/sent/dead) / `attempt_count` / `next_attempt_at` / `locked_by` / `locked_until` / `provider` / `provider_message_id` / `payload`(JSONB) 等。

`users.email_verified` 不变量：只有「TTL 内成功验证当前邮箱」才置 true；token 过期/撤销/重复点击都不会把它写回 false。

## 服务拓扑（新增）

`compose.yml`（dev）与 `compose.prod.yml`（prod）都新增三个服务，复用同一镜像、只换 command：

| 服务 | 命令 | 说明 |
|------|------|------|
| `redis` | `redis:7-alpine` | Celery broker + cooldown / IP rate-limit key |
| `celery-worker` | `celery -A app.tasks.celery_app worker` | 执行 `send_email_outbox` / `sweep_email_outbox`，可多副本 |
| `celery-beat` | `celery -A app.tasks.celery_app beat` | **只调度**周期 sweep，**必须单实例**（多实例会重复调度），`restart: unless-stopped` + 监控 |

现有 `worker`（LLM run）保持独立，不承担邮件发送。API 与 Celery 各用一套数据库引擎：API 异步（asyncpg），Celery 同步（psycopg，URL 由 `DATABASE_URL` 把 `+asyncpg` 换成 `+psycopg` 派生，见 `app/db/sync_session.py`）。

## 关键行为

- **Celery 投递失败不影响 API**：API 提交事务后 best-effort `send_email_outbox.delay(outbox_id)`；Redis/Celery 不可用时 API 仍成功，outbox 保持 `pending`，由 celery-beat 周期 `sweep_email_outbox` 补投。
- **claim/lease**：worker 先原子认领 outbox（`status=pending` → `sending` + `locked_until` lease）才发信；崩溃后 lease 过期由 sweep 复位为 `pending`。
- **attempt_count 仅在发起 Postmark 前自增**：claim 后、发信前崩溃被重新 claim 不消耗重试预算。
- **重试退避**：1m / 5m / 15m / 1h / 6h，超 `EMAIL_OUTBOX_MAX_ATTEMPTS`（默认 5）进 `dead`。401/403/422 等配置类错误直接 `dead`。
- **at-least-once**：Postmark 已接受但写 `sent` 前崩溃 → lease 恢复后可能重复发一封，验证邮件可接受，本期不防重。
- **Redis 故障策略**：register 优雅降级（邮箱 cooldown 查 DB、IP fail-open，注册保持可用）；resend fail closed（429）；verify fail open（高熵 token 不应被 Redis 故障阻塞）。

## 新增配置

完整见 `.env.example`。要点：

```env
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=          # 留空：任务结果只写回 email_outbox

FRONTEND_APP_URL=https://chat.feslia.com   # 验证链接指向这里

EMAIL_PROVIDER=postmark         # postmark | console | fake
EMAIL_FROM=iChat <no-reply@mail.feslia.com>
POSTMARK_SERVER_TOKEN=...       # 仅 EMAIL_PROVIDER=postmark 时被校验非空
POSTMARK_MESSAGE_STREAM=outbound

AUTH_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS=86400
AUTH_EMAIL_VERIFICATION_COOLDOWN_SECONDS=60
AUTH_RATE_REGISTER_IP_LIMIT=5
AUTH_RATE_RESEND_IP_LIMIT=10
AUTH_RATE_VERIFY_IP_LIMIT=30
EMAIL_OUTBOX_MAX_ATTEMPTS=5
EMAIL_OUTBOX_LEASE_SECONDS=120
EMAIL_OUTBOX_SWEEP_INTERVAL_SECONDS=60
```

- dev / CI 用 `EMAIL_PROVIDER=console`（打印日志）或 `fake`（测试内存收集），无需 Postmark 密钥即可 `compose up` 与跑测试。
- 修改 `.env` 后须 `docker compose -f compose.prod.yml up -d --force-recreate api celery-worker celery-beat`（`restart` 不重载 env）。

## Postmark 生产准备

1. 在 Postmark 创建 server，取 **Server API Token**（仅放后端 `.env`，不进前端）。
2. 验证发信域 `mail.feslia.com`：配置并通过 **DKIM**、**SPF（Return-Path/自定义回邮域）**；确认 `no-reply@mail.feslia.com` sender 可发信。
3. `MessageStream` 用事务流 `outbound`。
4. 本期不接 bounce / delivery webhook：`sent` 表示 Postmark **已接受**发送请求，不代表最终送达。

## 真实客户端 IP（Cloudflare → 源站 nginx → api）

两层互补，都在 nginx 完成（api 在 Docker 内网，对端永远是 nginx）：

1. **源站防火墙（网络层，手动运维）**：源站 VPS 的公网入口端口（nginx 的 80 / 8443）只放行 Cloudflare IP 段（云安全组 / iptables）。防止他人拿到源站真实 IP 绕过 CF。
2. **nginx realip（请求层，已在 `deploy/nginx.conf`）**：`set_real_ip_from <CF 段>` + `real_ip_header CF-Connecting-IP`，先校验来源在 CF 段才取真实客户端 IP 改写 `$remote_addr`，伪造无效。现有 `proxy_set_header X-Real-IP $remote_addr` 自动携带真实 IP，**API 只读 `X-Real-IP`**（dev 无 nginx 时回退 `request.client.host`）。

### CF IP 段同步 ops 清单（定期执行）

Cloudflare IP 段会变更，`deploy/nginx.conf` 的 `set_real_ip_from` 列表与源站防火墙规则都需同步：

1. 拉取最新列表：`https://www.cloudflare.com/ips-v4` 与 `https://www.cloudflare.com/ips-v6`（官方页 https://www.cloudflare.com/ips/）。
2. 更新 `deploy/nginx.conf` 中的 `set_real_ip_from` 段，提交 PR 部署，`docker compose -f compose.prod.yml up -d --force-recreate nginx`（或 reload nginx）。
3. 同步更新云防火墙 / iptables 中放行 80、8443 的 CF 段。
4. **不要**把 api 容器端口直接发布到公网绕过 nginx。

## 运维：查看日志与排查 dead outbox

```bash
# Celery 日志
docker compose -f compose.prod.yml logs -f celery-worker
docker compose -f compose.prod.yml logs -f celery-beat

# 查看 dead / 卡住的邮件任务
docker compose -f compose.prod.yml exec postgres \
  psql -U ichat ichat -c \
  "select id, status, attempt_count, last_error, next_attempt_at from email_outbox where status='dead' order by id desc limit 20;"

# 人工重投一条 dead（确认根因已修复后）：重置为 pending，beat sweep 会重新投递
docker compose -f compose.prod.yml exec postgres \
  psql -U ichat ichat -c \
  "update email_outbox set status='pending', attempt_count=0, next_attempt_at=now(), last_error=null where id=<ID>;"
```

`dead` 常见原因：Postmark token 错误 / sender 未验证（401/403/422，`last_error` 可见）。修复 env 或 DNS 后再重投。

## 验证

后端（先停 `worker` 与 `celery-worker` 容器，避免抢占测试 run/outbox）：

```bash
pytest            # token / verify / resend / outbox claim·lease·retry·dead / 限流 / 降级
ruff check app tests
mypy app
```

端到端（dev，`EMAIL_PROVIDER=console`）：

```bash
docker compose up -d            # postgres / redis / api / worker / celery-worker / celery-beat 全 healthy
docker compose exec api alembic upgrade head
# 注册新用户 → celery-worker 日志打印验证邮件 → 复制链接 token
#   → POST /api/v1/auth/verify-email → GET /api/v1/auth/me 返回 email_verified=true
```

## 2026-07-12 生产就绪验收

验收在本地完整依赖拓扑中执行：PostgreSQL、Redis、API、2 个 LLM worker、Celery worker 和单实例 Celery beat。邮件 provider 使用 `console`，因此验证了真实 API、数据库、broker、worker 与 outbox 状态流转，但没有向外部邮箱发送邮件。

### 执行命令与结果

```bash
# 依赖与迁移
uv sync --all-groups --frozen
pnpm --dir frontend install --frozen-lockfile
docker compose up -d postgres redis
DATABASE_URL=postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat \
  uv run alembic upgrade head

# 后端
DATABASE_URL=postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat \
EMAIL_PROVIDER=fake \
REDIS_URL=redis://localhost:6379/0 \
CELERY_BROKER_URL=redis://localhost:6379/0 \
  uv run pytest --tb=short -q
uv run ruff check .
uv run mypy app

# 前端
pnpm --dir frontend exec vitest run
pnpm --dir frontend run lint
pnpm --dir frontend run typecheck
pnpm --dir frontend run build

# Compose 解析、完整开发拓扑与健康检查
docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
docker compose up -d --build
docker compose ps --all
curl -fsS http://localhost:8000/healthz
curl -fsS http://localhost:8000/readyz
docker compose exec -T redis redis-cli ping
docker compose exec -T postgres pg_isready -U ichat -d ichat
docker compose exec -T celery-worker celery -A app.tasks.celery_app inspect ping
```

结果：

- 后端：`346 passed`；Ruff 全部通过；严格 MyPy 在 80 个 source files 上无错误。
- 前端：56 个 test files、323 个 tests 全部通过；ESLint、TypeScript typecheck 和生产构建通过。Vite 仅报告现有主 bundle 超过 500 kB 的非阻塞警告。
- Compose：开发与生产配置均解析成功；开发拓扑全部启动，migration 以 0 退出，PostgreSQL / Redis healthy，API `/healthz` 与 `/readyz` 均返回 `{"status":"ok"}`，Celery worker ping 返回 `pong`。
- Postmark：使用当前 `.env` 中的 Server Token，以 `EMAIL_PROVIDER=postmark` 完成配置模型校验；未调用 Postmark API，也未发送真实邮件。

### 真实依赖 smoke 结果

使用唯一测试用户通过运行中的 API 执行以下流程，并直接观察 PostgreSQL outbox 状态及 Celery worker 日志：

1. `POST /api/v1/auth/register` 返回 201，创建 token 与 outbox。
2. 注册后立即 `POST /resend-verification-email` 返回 429，并包含 `Retry-After`，证明注册与重发共享邮箱 cooldown。
3. 非法格式 token 调用 `POST /verify-email` 返回 422。
4. 注册 outbox（本次本地 ID 776）由 Celery worker 通过 `console` provider 发送，最终为 `sent`、`attempt_count=1`。
5. outbox 验证链接返回 200；随后 `GET /auth/me` 返回 `email_verified=true`。
6. 重复使用同一验证链接返回 400。
7. 另建一条模拟崩溃 worker 的过期 `sending` lease（本次本地 ID 777），触发 `sweep_email_outbox`；sweep 将其恢复并重新入队，Celery worker 最终写为 `sent`、`attempt_count=1`、锁字段清空、provider 为 `console`。

对应 Celery 日志包含：

```text
send_email_outbox outbox_id=776 result=sent
sweep_email_outbox re-enqueued 1 outbox rows
send_email_outbox outbox_id=777 result=sent
```

自动化套件同时覆盖并发 claim、发送前/后崩溃、过期 owner 不能覆盖新 lease、有效 lease 不被 sweep、重试预算耗尽及非重试错误进入 dead。

### 上线前仍需人工完成

1. 生产 `.env` 设置 `EMAIL_PROVIDER=postmark`，确认 `FRONTEND_APP_URL=https://chat.feslia.com`、sender、MessageStream 与 Server Token 均为生产值，然后 force-recreate `api celery-worker celery-beat`。
2. 在 Postmark 控制台确认 `mail.feslia.com` 的 DKIM、SPF / Return-Path 与 `no-reply@mail.feslia.com` sender 均已验证；向受控真实邮箱执行一次送达测试。此次本地验收没有发送真实邮件。
3. 在生产服务器实际执行迁移与完整拓扑部署，确认 Redis、API、LLM worker、Celery worker、单实例 Celery beat 和 nginx 均运行；本地验收只验证了生产 Compose 解析和自动部署顺序，没有操作生产服务器。
4. 同步 Cloudflare 最新 IP 段到 nginx 与源站防火墙，确保公网只能经 Cloudflare 访问源站 80 / 8443。
5. 上线后监控 Celery worker / beat，检查 `dead` outbox，并确认 beat 始终只有一个实例。

## 未来扩展

复用 `auth_tokens` / outbox / rate limit / Postmark adapter 即可加 `password_reset`、`account_deletion`，以及接 Postmark bounce/delivery webhook 记录最终投递状态。
