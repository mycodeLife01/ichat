# 邮箱验证与认证邮件基础设施设计

日期：2026-06-21
分支：`feat/email-verification`

## 背景

iChat 目前已经有账号密码注册/登录、JWT access token、refresh token 轮换，以及 `users.email_verified` 字段。首个迁移中还预留了 `email_verification_tokens` 表，但业务层尚未接入邮箱验证邮件发送。

本次要补齐生产稳定的邮箱验证流程，并顺手打好后续认证类邮件能力的基础。设计重点不是“注册后发一封邮件”这么简单，而是：

* 认证 token 从邮箱验证专用表升级为通用 `auth_tokens`，用 `purpose` 区分邮箱验证、密码重置、注销确认等用途。
* 邮件发送采用 PostgreSQL outbox 作为事实源，Redis + Celery 作为异步执行通道。
* Redis 同时承担短 TTL 风控状态：同一用户/邮箱重发 cooldown、IP 维度限流。
* 多 worker 并发、重复任务、任务中断、邮件服务商瞬时失败都必须可恢复、可幂等。
* 未验证邮箱的用户可以继续使用产品，但前端持续提示完成验证。

## 已确认决策

| 项            | 决策                                                              |
| ------------ | --------------------------------------------------------------- |
| 邮件服务商        | Postmark HTTP API                                               |
| 发件身份         | `iChat <no-reply@mail.feslia.com>`                              |
| 前端验证链接       | `https://chat.feslia.com/verify-email?token=...`                |
| 未验证用户权限      | 不限制聊天、分享、发送消息，只持续提示                                             |
| 异步任务         | Redis + Celery，独立 `celery-worker` / `celery-beat` 服务            |
| 任务事实源        | PostgreSQL `email_outbox`，Redis 不保存最终业务状态                       |
| Redis 额外用途   | cooldown / IP rate limit 的短 TTL key                             |
| 多 worker 并发  | PostgreSQL 原子 claim、row lock、lease、幂等状态机                        |
| 第一阶段 purpose | 只实现 `email_verification`；预留 `password_reset`、`account_deletion` |
| Celery DB 访问 | 独立 **sync** engine（psycopg）跑 outbox claim/update；API 侧保持 async |
| token 表迁移 | drop `email_verification_tokens` + create `auth_tokens`，作废旧 token |
| 真实客户端 IP | nginx `realip`（`set_real_ip_from` CF 段 + `real_ip_header CF-Connecting-IP`）+ 源站防火墙锁 CF 段，API 读 `X-Real-IP` |
| dev/CI 邮件 | `EMAIL_PROVIDER=console/fake`；Postmark 字段仅 `postmark` 时校验 |
| 限流响应头 | 扩展 `AppError` 支持 `headers`，429 携带 `Retry-After` |
| register 降级 | Redis 挂时同邮箱 cooldown 查 DB、同 IP 滑窗 fail-open，注册保持可用 |
| outbox 恢复 | celery-beat 调度 `sweep_email_outbox`，任意 worker 执行；beat 单实例+监控 |
| 重试与重复 | `attempt_count` 在发起 Postmark 时自增；接受 crash-after-send 偶发重复 |

## 目标

1. 注册后自动创建邮箱验证 token，并异步发送验证邮件。
2. 支持登录用户重发验证邮件，带用户/邮箱 cooldown 和 IP 限流。
3. 支持公开验证链接，验证成功后设置 `users.email_verified = true`。
4. 前端为未验证用户持续展示提示和重发入口。
5. 后端新增 `GET /api/v1/auth/me`，让前端刷新当前 user 状态。
6. 迁移 `email_verification_tokens` 为通用 `auth_tokens`，为后续认证 token 用途预留。
7. 新增生产可恢复的邮件 outbox、Celery worker、Celery beat、Redis broker。
8. 明确多 worker 并发、任务重复、Redis 故障、Postmark 故障时的行为。

## 非目标

* 不实现密码重置、注销账号确认，只预留 `auth_tokens.purpose`。
* 不强制未验证用户退出或禁止聊天。
* 不引入 cookie session 或修改现有 JWT/refresh token 机制。
* 不把现有 LLM `app.worker` 改造成 Celery worker；二者保持独立。
* 不在第一版接 Postmark bounce / delivery webhook。v1 的 `sent` 表示 Postmark API 接受发送请求，不表示最终送达。
* 不做邮件模板管理后台；模板先以代码/函数生成。

## 总体架构

```text
浏览器
  │
  │ register / resend / verify
  ▼
FastAPI API
  │
  ├─ PostgreSQL: users / auth_tokens / email_outbox
  │       ▲
  │       │ claim / status update / recovery scan
  │       │
  ├─ Redis: Celery broker + cooldown/rate-limit keys
  │       ▲
  │       │ Celery task messages
  ▼       │
Celery worker / beat
  │
  ▼
Postmark HTTP API
```

关键原则：

* PostgreSQL 是业务事实源：token 是否有效、邮件是否应发送、邮件发送状态、用户是否验证都在数据库。
* Redis 是短期执行和风控层：任务消息、cooldown、rate limit。Redis 丢数据最多导致短期限流状态丢失或任务需要 beat 重新投递，不导致 token/outbox/user 状态丢失。
* Celery/Redis 语义按 at-least-once 处理：任务可以重复，消费者必须幂等。

## 数据模型

### `auth_tokens`

替代现有 `email_verification_tokens`。迁移策略：**drop 旧表 + create 新表 `auth_tokens`**（旧 token 语义不保留，作废生产中所有未验证 token，用户重发即可）。选择 drop+create 而非 rename+加列，是为了避免 `token_hash` 255→64 缩列、新增 NOT NULL 列的回填、以及半新半旧行等问题。`token_hash` 用 `String(64)` 容纳 SHA-256 十六进制。

字段：

| 字段              | 类型                   | 说明                                                              |
| --------------- | -------------------- | --------------------------------------------------------------- |
| `id`            | BigInteger PK        | 内部主键                                                            |
| `user_id`       | FK -> users.id       | token 所属用户                                                      |
| `purpose`       | String(64)           | `email_verification` / 预留 `password_reset` / `account_deletion` |
| `token_hash`    | String(64) unique    | SHA-256 hash；不保存原文 token                                        |
| `sent_to_email` | String(254)          | 本 token 绑定的邮箱，验证时必须匹配当前用户邮箱或按策略拒绝                               |
| `expires_at`    | timestamptz          | 验证 token 默认 24 小时有效                                             |
| `used_at`       | timestamptz nullable | 成功使用时间                                                          |
| `revoked_at`    | timestamptz nullable | 被重发/安全操作撤销时间                                                    |
| `created_at`    | timestamptz          | 创建时间                                                            |

索引与约束：

* `uq_auth_tokens_token_hash` unique。
* `ix_auth_tokens_user_purpose` on `(user_id, purpose)`。
* `ix_auth_tokens_expires_at` on `expires_at`。
* 可选但推荐：partial unique index `(user_id, purpose)` where `used_at IS NULL AND revoked_at IS NULL`。服务层创建新 token 前先撤销旧 active token，索引用于兜底捕捉并发 bug。

### `email_outbox`

邮件任务事实源。Celery task 只携带 `outbox_id`，真正任务内容从此表读取。

字段：

| 字段                          | 类型                   | 说明                                      |
| --------------------------- | -------------------- | --------------------------------------- |
| `id`                        | BigInteger PK        | outbox 任务 id                            |
| `kind`                      | String(64)           | `email_verification`                    |
| `recipient_email`           | String(254)          | 收件邮箱                                    |
| `subject`                   | String(255)          | 邮件主题                                    |
| `template`                  | String(64)           | 例如 `email_verification`                 |
| `payload`                   | JSONB                | 邮件渲染数据，包含验证链接、用户名、过期时间等                 |
| `status`                    | String(32)           | `pending` / `sending` / `sent` / `dead` |
| `attempt_count`             | Integer              | 尝试次数                                    |
| `next_attempt_at`           | timestamptz          | 下次可尝试时间                                 |
| `locked_by`                 | String nullable      | 当前认领任务 id / worker id                   |
| `locked_until`              | timestamptz nullable | 发送 lease 到期时间                           |
| `provider`                  | String nullable      | `postmark`                              |
| `provider_message_id`       | String nullable      | Postmark 返回的 `MessageID`                |
| `last_error`                | Text nullable        | 最近一次错误，截断保存                             |
| `sent_at`                   | timestamptz nullable | Postmark 接受时间                           |
| `created_at` / `updated_at` | timestamptz          | 审计时间                                    |

索引：

* `ix_email_outbox_status_next_attempt` on `(status, next_attempt_at)`。
* `ix_email_outbox_locked_until` on `locked_until`。
* `ix_email_outbox_created_at` on `created_at`。

状态语义：

* `pending`：可发送或等待 `next_attempt_at`。
* `sending`：某 worker 已认领，受 `locked_until` lease 保护。
* `sent`：Postmark API 已接受。
* `dead`：超过最大重试次数，等待人工排查。

## Token 与验证语义

### Token 生成

* 原文 token 使用 `secrets.token_urlsafe(32)`，只在邮件链接中出现一次。
* 数据库存 `sha256(token)`。
* 验证链接：`${FRONTEND_APP_URL}/verify-email?token=${token}`。
* `email_verification` TTL 默认 24 小时。

### `email_verified` 状态不变量

`users.email_verified` 表示“用户当前邮箱已经被成功验证”的事实，不表示“当前是否存在有效验证 token”。

* 注册时 `email_verified = false`。
* 验证 token 在 TTL 内成功使用后，才设置 `email_verified = true`。
* token 过期、撤销、发送失败或进入 `dead` outbox，都不会把 `email_verified` 重置为 `false`。未验证用户本来保持 `false`；已验证用户不应被旧 token 或过期 token 回滚。
* 本期不实现邮箱变更流程。未来如果支持修改邮箱，修改邮箱时必须显式把 `email_verified` 重置为 `false`，并为新邮箱签发新的 `email_verification` token；这属于邮箱变更功能，不属于 token TTL 过期处理。

状态表：

| 场景                      | `email_verified` |
| ----------------------- | ---------------- |
| 新注册，尚未点击验证链接            | `false`          |
| 新注册，验证 token 已过期且从未验证   | `false`          |
| 在 TTL 内成功验证当前邮箱         | `true`           |
| 已验证后，旧 token 过期/撤销/重复点击 | 保持 `true`        |

### 验证

验证接口必须用原子更新，避免重复点击并发：

```sql
UPDATE auth_tokens
SET used_at = now()
WHERE token_hash = :token_hash
  AND purpose = 'email_verification'
  AND used_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now()
RETURNING user_id, sent_to_email;
```

拿到返回行后：

* 加载用户。
* 若用户已 `email_verified = true`，返回成功幂等结果。
* 若 `sent_to_email` 与当前用户邮箱不一致，返回通用失败，防止以后改邮箱导致旧链接验证新邮箱。`sent_to_email` 按与 `users.email` 相同的规范化形式（`strip().lower()`）存储与比较。
* 设置 `users.email_verified = true`。

> 注意：上面的原子 UPDATE 会在比对 `sent_to_email` **之前**就把 token 标记为已用（`used_at`）。当前不支持邮箱变更，`sent_to_email` 必然等于当前邮箱，不会触发不匹配分支；待未来做邮箱变更时，应把邮箱匹配条件并入 `WHERE`、或匹配通过后再消费，避免「校验失败却烧掉 token」。

重复点击已用 / 过期 token：

* `/auth/verify-email` 是**公开无认证**端点，拿不到当前用户上下文，因此对已用 / 过期 / 撤销 / 不存在的 token **一律返回通用失败**，不区分原因。
* 「其实已经验证过」的幂等友好提示由**前端**负责：验证页在失败后，若本地有 session 则调用 `GET /auth/me`，发现 `email_verified=true` 就改判为成功。后端公开端点不承担这个判断。

前端文案采用通用失败：“验证链接已失效或不可用”。如果当前已登录且邮箱未验证，展示“重新发送验证邮件”。

## API 设计

### `GET /api/v1/auth/me`

需要认证。返回当前 `AuthUserResponse`：

```json
{
  "data": {
    "id": 1,
    "username": "alice",
    "email": "alice@example.com",
    "email_verified": true
  }
}
```

用途：

* 前端启动或验证成功后刷新 session user。
* 不签发新 access/refresh token。

### `POST /api/v1/auth/verify-email`

公开接口。请求：

```json
{
  "token": "raw-token-from-email"
}
```

响应：

```json
{
  "data": {
    "status": "ok"
  }
}
```

错误：

* token 格式空/非法：422。
* token 不存在、过期、已撤销、邮箱不匹配：400，`"Invalid or expired verification link"`。
* Redis rate limit 不可用时不阻止验证，详见故障策略。

### `POST /api/v1/auth/resend-verification-email`

需要认证。行为：

1. 检查用户未验证；已验证则返回 `status=ok`，不发送。
2. Redis 检查用户 cooldown 和 IP rate limit。
3. DB 事务中 `SELECT users ... FOR UPDATE`。
4. 撤销旧 active `email_verification` token。
5. 创建新 `auth_tokens`。
6. 创建 `email_outbox`。
7. commit 后 best-effort 投递 Celery task。

响应：

```json
{
  "data": {
    "status": "ok"
  }
}
```

冷却/限流错误：

* 429，响应头带 `Retry-After`（通过扩展后的 `AppError.headers` 透传，见「错误处理」）。
* 错误 detail 使用英文，例如 `"Please wait before requesting another verification email"`。

### `POST /api/v1/auth/register`

保持现有响应结构和自动登录行为。新增行为：

* 注册事务内创建 `auth_tokens(email_verification)` 和 `email_outbox`。
* commit 后 best-effort 投递 outbox task。
* 受 IP 限流和邮箱维度 cooldown 保护。
* Redis 不可用时**优雅降级**而非整体 fail closed：同邮箱 cooldown 回退查 DB（`auth_tokens.created_at` 即「上次发信时间」事实源，60s 内已建过则拒），同 IP 滑窗因无 Redis、DB 不存 IP 而 fail-open 跳过。净效果：注册保持可用，故障期 anti-abuse 降为「仅同邮箱级」；Redis 正常时仍由它主控限流。

## Redis 设计

Redis 用途：

1. Celery broker。
2. cooldown key。
3. IP rate limit key。

Redis 不保存：

* token 原文或 hash。
* 邮件最终状态。
* 用户是否验证。
* outbox 任务内容。
* Celery task 结果。Celery result backend 不启用；任务执行结果只写回 `email_outbox`。

### Cooldown key

同一登录用户重发：

```text
auth:cooldown:email_verification:user:{user_id}
```

同一邮箱注册/重发保护：

```text
auth:cooldown:email_verification:email:{sha256(normalized_email)}
```

设置方式：

```text
SET key 1 NX EX 60
```

失败（key 已存在）则返回 429。`SET NX` 占锁后若后续 DB 事务回滚 / 提交失败，best-effort `DEL` 释放该 key，避免用户被「什么都没发生却锁 60s」。

### IP rate limit key

```text
auth:rate:register:ip:{ip}
auth:rate:resend_verification:ip:{ip}
auth:rate:verify_email:ip:{ip}
```

默认限制：

| 接口                  | 默认阈值         |
| ------------------- | ------------ |
| register            | 5 / 小时 / IP  |
| resend verification | 10 / 小时 / IP |
| verify email        | 30 / 分钟 / IP |

算法：

* 使用 Redis Lua 实现 sliding window，保证“清理旧记录、计数、写入当前请求、设置 TTL”原子。
* 返回 `allowed`、`retry_after_seconds`。
* `Retry-After` 响应头用 `retry_after_seconds`。

### Redis 故障策略

| 场景                        | 策略                                    | 原因                                    |
| ------------------------- | ------------------------------------- | ------------------------------------- |
| register                  | 优雅降级：邮箱 cooldown 查 DB、IP 滑窗 fail-open | 注册是转化关键路径，不应整体吊死在 Redis；DB 仍能拦同邮箱重复发信 |
| resend-verification-email | fail closed                           | 防止邮件轰炸                                |
| verify-email              | fail open                             | token 高熵且不触发发信，不应因 Redis 故障阻止用户完成验证   |
| Celery `.delay()` 失败      | 不影响 API 成功；依赖 outbox + beat 恢复        | DB 已有事实记录                             |

## Celery 与 outbox 执行

### 服务划分

新增服务：

* `redis`
* `celery-worker`
* `celery-beat`

现有 `worker` 继续只处理 LLM run，不承担邮件发送。

建议模块：

```text
app/tasks/
  celery_app.py        # Celery 实例与配置
  email_tasks.py       # send_email_outbox / sweep_email_outbox

app/services/email/
  renderer.py          # 邮件模板渲染
  postmark.py          # Postmark adapter
  outbox.py            # claim / mark sent / retry / dead

app/services/auth/
  token_service.py     # auth_tokens 创建/撤销/验证
  verification.py      # 注册/重发/验证 orchestration
  rate_limit.py        # Redis cooldown / IP limit
```

### 数据库访问（async / sync 分离）

API 是异步栈（`asyncpg` + async SQLAlchemy），Celery worker 是同步进程，二者各用一套 engine、互不干扰：

* API 侧：沿用现有 async engine / `AsyncSession`，负责 register / resend / verify 里创建 `auth_tokens`、`email_outbox`、读写 `users`。
* Celery 侧：新增**独立 sync engine（`postgresql+psycopg://`）+ 同步 `Session`**，负责 outbox 的 claim / 状态更新 / sweep。sync URL 可由现有 `DATABASE_URL` 把驱动从 `+asyncpg` 换成 `+psycopg` 派生，无需新增连接串配置。
* 服务函数按职责拆分：API 用到的创建逻辑是 async，Celery 用到的 claim/update/sweep 是 sync，二者操作同一批表但不同操作。**不**在 Celery 任务里 `asyncio.run` 复用 async session（每任务新建 event loop、asyncpg 绑定 loop 易出问题）。
* sync engine 的连接数计入 PostgreSQL `max_connections` 预算（见「部署与配置」）。

### Task 投递

API commit 后：

```text
send_email_outbox.delay(outbox_id)
```

如果 Redis/Celery 不可用：

* API 仍返回成功，前提是 DB 事务已提交。
* `email_outbox.status='pending'` 保留。
* `celery-beat` 周期扫描 pending/expired lease 任务重新投递。

### Worker claim

worker 必须先认领 outbox，认领成功才调用 Postmark：

```sql
UPDATE email_outbox
SET status = 'sending',
    locked_by = :task_id,
    locked_until = now() + interval '2 minutes',
    updated_at = now()
WHERE id = :outbox_id
  AND status = 'pending'
  AND next_attempt_at <= now()
RETURNING *;
```

如果没有返回行，说明任务已被处理、正在处理、未到重试时间或已 dead，worker 直接退出。

claim 本身**不**自增 `attempt_count`：`attempt_count` 表示「真正发起 Postmark 投递的次数」，在调用 Postmark **之前**那一刻 +1。这样 claim 后、发信前崩溃 → lease 过期 → 被重新 claim 的抖动，不会消耗重试预算，避免 worker 还没打到 Postmark 就把 5 次用尽进 dead。

### 发送成功

Postmark 返回成功后：

```text
status = sent
provider = postmark
provider_message_id = response.MessageID
sent_at = now()
locked_by = null
locked_until = null
last_error = null
```

> at-least-once 语义下有一个固有窗口：Postmark 已接受、但 worker 在写回 `status=sent` 前崩溃 → lease 过期 → 重新 claim → 重复发送一封。Postmark `/email` 无原生幂等键（`Metadata.outbox_id` 仅用于追踪），对验证邮件偶发重复一封无害，本期**接受不做防重**。

### 发送失败

失败分类：

* 网络超时、5xx、Postmark 暂时性错误：可重试。
* 401/403 配置错误、422 sender 未验证或请求结构错误：通常不可重试，直接 `dead` 或少量重试后 dead。

默认重试：

* 最多 5 次。
* 指数退避，例如 1 分钟、5 分钟、15 分钟、1 小时、6 小时。
* 每次失败写 `last_error`，截断到安全长度。

### Lease 恢复

`celery-beat` 只**调度**周期任务 `sweep_email_outbox`（每 `EMAIL_OUTBOX_SWEEP_INTERVAL_SECONDS` 一次），真正的扫描由任意 celery-worker 领取执行：

* `status = 'pending' AND next_attempt_at <= now()`：投递 `send_email_outbox` task。
* `status = 'sending' AND locked_until < now()`：恢复为 `pending`，设置下一次 `next_attempt_at`，再投递。

这样 worker 在发信前/发信中崩溃不会永久卡死。注意 celery-beat 必须**单实例**运行（多实例会重复调度），是调度层的单点，需配 `restart: unless-stopped` + 监控告警；但「执行」分布在所有 worker 上，beat 短暂缺席只是延迟恢复，已 `.delay()` 的任务仍照常被 worker 消费。

## Postmark 集成

使用 Postmark HTTP API 发送单封事务邮件：

* endpoint：`POST https://api.postmarkapp.com/email`
* headers：`Accept: application/json`、`Content-Type: application/json`、`X-Postmark-Server-Token`
* body：`From`、`To`、`Subject`、`HtmlBody`、`TextBody`、`MessageStream`
* response：记录 `MessageID`

Postmark 官方文档说明单封邮件使用 `/email` endpoint，server token 放在 `X-Postmark-Server-Token` header；响应里包含 `MessageID`。文档还说明 `MessageStream` 未提供时默认使用 `outbound` transactional stream，并支持 `Metadata` 对象。参考：

* [Sending email with API](https://postmarkapp.com/developer/user-guide/send-email-with-api)
* [Email API](https://postmarkapp.com/developer/api/email-api)
* [Custom metadata FAQ](https://postmarkapp.com/support/article/1125-custom-metadata-faq)

请求示意：

```json
{
  "From": "iChat <no-reply@mail.feslia.com>",
  "To": "alice@example.com",
  "Subject": "Verify your iChat email",
  "HtmlBody": "<p>...</p>",
  "TextBody": "...",
  "MessageStream": "outbound",
  "Tag": "email_verification",
  "Metadata": {
    "outbox_id": "12345"
  }
}
```

配置：

```env
EMAIL_PROVIDER=postmark
EMAIL_FROM=iChat <no-reply@mail.feslia.com>
EMAIL_REPLY_TO=
POSTMARK_SERVER_TOKEN=...
POSTMARK_MESSAGE_STREAM=outbound
POSTMARK_BASE_URL=https://api.postmarkapp.com
POSTMARK_TIMEOUT_SECONDS=10
```

测试环境：

* 单元测试使用 fake adapter。
* 可选集成测试可使用 Postmark 的测试 server token 机制；不作为 CI 必需项。

## 前端设计

### Auth session

`AuthUserResponse` 已包含 `email_verified`。前端需新增：

* `authApi.me()`。
* session user 更新 action，例如 `auth/userUpdated`。
* 验证成功或重发成功后保持原 session，不重新登录。
* App 启动恢复本地 session 后，可调用 `authApi.me()` 刷新 user 镜像；401 仍走现有 auth expired/reset 逻辑。

### 未验证提示

在已登录 AppShell 中持续显示一个轻量提示条：

* 文案中文，例如“请验证你的邮箱，确保账号安全。”
* 显示目标邮箱。
* 按钮：“重新发送验证邮件”。
* 成功 toast：“验证邮件已发送，请检查邮箱。”
* 429 toast 可显示“请稍后再试”。

不禁用聊天、发送、分享、编辑、重生成。

### 验证页

新增路由（放在 `AuthGate` 之外，作为 `/share/:token` 的兄弟公开路由，置于 `*` catch-all 之前；登出状态点邮件链接也要能进）：

```text
/verify-email?token=...
```

行为：

1. 页面读取 token。
2. 调用 `authApi.verifyEmail(token)`。
3. 成功：

   * 如果当前有 session，调用 `authApi.me()` 刷新 user。
   * 展示成功状态和“返回 iChat”。
4. 失败：

   * 展示通用失败文案：“验证链接已失效或不可用”。
   * 如果当前已登录且邮箱未验证，显示“重新发送验证邮件”。
   * 否则引导回登录/注册页。

## 安全与隐私

### IP 获取

生产链路是 Cloudflare → 源站 nginx → api。真实客户端 IP 的获取分两层，「校验来源是否 CF」和「提取客户端 IP」都在 **nginx** 完成（api 容器在 Docker 内网，对端永远是 nginx，无法自行校验 CF）：

**第 1 层 · 源站防火墙（网络层）**

源站 VPS 的公网入口端口（nginx 的 80 / 8443）只放行 Cloudflare IP 段（云安全组 / iptables）。作用：别人即便拿到源站真实 IP 也连不上 nginx，无法绕过 CF（连同其 WAF / DDoS 防护）。前提是源站真实 IP 不泄露。

**第 2 层 · nginx realip（请求层）**

用 `ngx_http_realip_module` 先校验连接来源是否在 CF 段，通过才从 `CF-Connecting-IP` 取真实客户端并改写 `$remote_addr`；来源不在 CF 段则忽略该头、用实际对端 IP，因此伪造无效：

```nginx
# 只信任来自 Cloudflare 段的真实-IP 头（需列全 CF v4/v6 段，并定期同步）
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
# ... 其余 CF 段见 https://www.cloudflare.com/ips/
real_ip_header CF-Connecting-IP;
```

**API 侧**

启用 realip 后 `$remote_addr` 已是真实客户端，nginx 现有的 `proxy_set_header X-Real-IP $remote_addr`（`deploy/nginx.conf`）自动携带真实 IP。**API 只读 `X-Real-IP`**，不自行校验 CF（也无法校验）；信任成立是因为 api 只 `expose`、不对公网发布，唯一入口是 nginx。

> 两层互补：防火墙挡「非 CF 连接」，realip 保证「IP 归属正确且不被伪造」。CF IP 段会变更，`set_real_ip_from` 列表需定期同步（CF 官方有列表与脚本）。不要把 api 容器端口直接发布到公网绕过 nginx。

### Token 隐私

* token 原文只出现在邮件链接和前端 verify 请求中。
* 后端日志不得记录 token 原文。
* `auth_tokens.token_hash` 只存 SHA-256。
* 验证失败错误不区分不存在、过期、已撤销、已使用。

### 邮件内容

* 验证邮件不包含敏感聊天内容。
* 邮件链接只完成邮箱验证，不自动登录。
* Postmark metadata 只放 `outbox_id` 等内部关联 id，不放 token 原文。

## 部署与配置

新增依赖：

* `celery[redis]`
* Redis Python client 由 Celery extras 提供或显式加入 `redis`
* `psycopg`（Celery 侧同步 SQLAlchemy 驱动；见「Celery 与 outbox 执行 / 数据库访问」）

新增服务（dev `compose.yml` 与生产 `compose.prod.yml` 都要加，并接入 `depends_on` / healthcheck）：

* `redis`：Celery broker + cooldown / rate-limit。
* `celery-worker`：执行 `send_email_outbox` / `sweep_email_outbox`，可多副本。
* `celery-beat`：只调度周期 sweep，**必须单实例**（多实例会重复调度），配 `restart: unless-stopped` + 监控。

新增环境变量：

```env
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=

FRONTEND_APP_URL=https://chat.feslia.com

# postmark | console | fake；console/fake 用于本地/CI，不校验下面的 Postmark 字段
EMAIL_PROVIDER=postmark
EMAIL_FROM=iChat <no-reply@mail.feslia.com>
EMAIL_REPLY_TO=
POSTMARK_SERVER_TOKEN=
POSTMARK_MESSAGE_STREAM=outbound
POSTMARK_BASE_URL=https://api.postmarkapp.com
POSTMARK_TIMEOUT_SECONDS=10

AUTH_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS=86400
AUTH_EMAIL_VERIFICATION_COOLDOWN_SECONDS=60

AUTH_RATE_REGISTER_IP_LIMIT=5
AUTH_RATE_REGISTER_IP_WINDOW_SECONDS=3600
AUTH_RATE_RESEND_IP_LIMIT=10
AUTH_RATE_RESEND_IP_WINDOW_SECONDS=3600
AUTH_RATE_VERIFY_IP_LIMIT=30
AUTH_RATE_VERIFY_IP_WINDOW_SECONDS=60

EMAIL_OUTBOX_MAX_ATTEMPTS=5
EMAIL_OUTBOX_LEASE_SECONDS=120
EMAIL_OUTBOX_SWEEP_INTERVAL_SECONDS=60
```

Postmark 生产准备：

* `EMAIL_PROVIDER=console`（打印到日志）或 `fake`（测试内存收集）让 dev/CI 在无 Postmark 密钥时也能 `compose up` 与跑 smoke；config 仅在 `EMAIL_PROVIDER=postmark` 时校验 `POSTMARK_SERVER_TOKEN` 等非空。
* Celery 侧 sync engine 复用 `DATABASE_URL`（把 `+asyncpg` 换成 `+psycopg`），无需单独连接串；其连接数计入 `max_connections` 预算。
* 配置并验证 `mail.feslia.com` 相关 DKIM/SPF/Return-Path。
* 确认 `no-reply@mail.feslia.com` sender/domain 可发信。
* server token 只放后端环境变量，不进入前端。

## 错误处理

限流 / 冷却返回 429 时需带 `Retry-After` 头。现有 `AppError` 只有 `status_code` + `detail`，`main.py` 的 handler 返回的 `JSONResponse` 不带自定义头，因此**扩展 `AppError` 增加可选 `headers` 字段并在 handler 透传**；其余 4xx 行为不变。

| 场景                            | 行为                                           |
| ----------------------------- | -------------------------------------------- |
| 注册成功但 Celery 投递失败             | API 返回成功；outbox pending；beat 后续补投            |
| Postmark 暂时失败                 | outbox 退避重试                                  |
| Postmark 配置错误                 | outbox dead，日志告警                             |
| Redis cooldown/rate limit 不可用 | register 优雅降级（邮箱查 DB、IP fail-open）；resend fail closed；verify fail open |
| 用户已验证仍请求 resend               | 返回 ok，不发邮件                                   |
| 验证 token 过期/撤销/不存在            | 返回通用失败，不泄露原因                                 |
| 验证 token TTL 到期               | 只影响该 token 可用性，不修改 `users.email_verified`    |
| 重复点击已验证链接                     | 公开端点返回通用失败；前端凭 `me()` 改判为成功幂等               |
| Postmark 已接受但写 sent 前崩溃        | lease 恢复后可能重复发一封，验证邮件可接受，不做防重               |

## 测试计划

### 后端单元 / service 测试

* token 创建只保存 hash，不保存原文。
* token 验证成功设置 `used_at` 和 `users.email_verified=true`。
* 过期、撤销、已使用、邮箱不匹配返回失败。
* token 过期不会把未验证用户或已验证用户的 `email_verified` 写回 `false`。
* 重发会 revoke 旧 active token，并创建新 token/outbox。
* 同一用户并发重发只产生一个 active token。
* outbox claim 在并发 worker 下只有一个成功。
* sending lease 超时可恢复为 pending。
* 失败重试次数和 next_attempt_at 正确。
* 超过最大次数进入 dead。
* `attempt_count` 仅在发起 Postmark 时自增；claim 后、发信前崩溃被重新 claim 不消耗重试预算。
* Redis cooldown `SET NX EX` 命中时返回 429。
* cooldown 占锁后 DB 事务回滚会 best-effort `DEL` 释放该 key。
* IP sliding window 超限返回 retry_after。

### API 测试

* 注册仍返回 AuthTokenResponse，且创建 token/outbox。
* `/auth/me` 返回当前用户和 `email_verified`。
* `/auth/verify-email` happy path。
* `/auth/verify-email` 对无效 token 返回通用错误。
* `/auth/resend-verification-email` happy path / 已验证 / cooldown / IP rate limit。
* cooldown / rate limit 的 429 响应带 `Retry-After` 头。
* Redis 不可用时 register 仍成功：同邮箱 DB cooldown 拦住短时重复、同 IP fail-open 放行。
* 未认证调用 resend 返回 401。

### Celery / Postmark adapter 测试

* fake Postmark 成功时 outbox 标记 sent，保存 provider_message_id。
* fake Postmark 5xx/timeout 触发重试。
* fake Postmark 401/422 进入 dead 或按配置少量重试后 dead。
* task 重复执行时第二个 worker 无法 claim，直接退出。

### 前端测试

* 未验证 session 显示提示条，已验证不显示。
* 点击重发调用 API，成功显示 toast。
* 429 显示稍后再试。
* `/verify-email?token=...` 成功后刷新 `me` 并隐藏提示。
* 验证失败显示通用失败，并在已登录未验证时显示重发按钮。

### 部署 / smoke

* `docker compose up -d` 后 Redis、api、worker、celery-worker、celery-beat 都健康。
* `EMAIL_PROVIDER=console/fake` 且无 Postmark token 时也能启动（strict config 不报错）。
* 本地 fake adapter 或 Postmark test token 验证注册后 outbox 被消费。
* 生产部署文档覆盖 Postmark DNS、env、日志查看和 dead outbox 排查。

## 实施阶段

1. **数据库与模型**：`auth_tokens` 迁移、`email_outbox`、模型与 schema。
2. **Redis 限流基础设施**：配置、客户端、cooldown、IP sliding window。
3. **Auth service 接入**：register 创建 token/outbox、verify、resend、me。
4. **邮件发送基础设施**：sync engine（psycopg）、Postmark adapter（含 console/fake）、renderer、outbox service、Celery app/task/beat。
5. **部署配置**：依赖（含 psycopg）、redis / celery 服务、nginx `realip`（CF 段）+ 源站锁 CF 段、CI env、`.env.example`、部署文档。
6. **前端体验**：未验证提示、重发、验证页、session user 刷新。
7. **端到端验证**：本地 fake/Postmark test、生产配置检查、回归测试。

## 未来扩展

* `password_reset`：复用 `auth_tokens`、outbox、rate limit、Postmark adapter，新增 public request reset + confirm reset。
* `account_deletion`：复用 `auth_tokens`，但验证后执行高风险账号操作。
* Postmark delivery/bounce webhook：记录最终投递状态，处理 bounce/suppression。
* 管理命令：重试 dead outbox、清理 sent outbox、审计用户认证邮件历史。
