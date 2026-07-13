# 密码重置、改密与账户注销（交接）

日期：2026-07-13
分支：`feat/email-verification`
需求来源：`.scratch/password-reset-account-deletion/PRD.md`
基础设施：`docs/handover/2026-06-26-email-verification.md`（通用认证令牌表、email outbox、Redis 限流/冷却）
决策记录：`docs/adr/2026-07-13-account-deletion-soft-deactivation.md`

## 概述

在既有认证邮件基础设施之上补齐三个账户生命周期能力，纯后端（前端页面单独一期）：

1. **密码重置**：匿名提交邮箱 → 收 30 分钟有效链接邮件 → 凭链接设新密码。
2. **改密**：已登录用户凭当前密码直接设新密码，不走邮件。
3. **注销**：已登录用户重输密码发起 → 收确认邮件 → 点击链接后账户立即软停用（数据保留）。

无数据库迁移：`auth_tokens.purpose` 早已预留 `password_reset` / `account_deletion`，本期只是启用。

## 新端点（均在 `/api/v1/auth` 下，返回既有命令状态响应 `{"status": "ok"}`，不自动登录）

| 端点 | 认证 | 行为 |
|---|---|---|
| `POST /request-password-reset` | 匿名 | 恒定 200 防枚举；仅存在且未停用的邮箱真正签发令牌并入 outbox |
| `POST /reset-password` | 匿名 | 消费令牌 + 设新密码（8–128 字符） |
| `POST /change-password` | 登录态 | 校验当前密码后设新密码 |
| `POST /request-account-deletion` | 登录态 | 重输密码（sudo mode）通过后发确认邮件 |
| `POST /confirm-account-deletion` | 匿名 | 消费令牌，账户软停用 |

代码位置：路由 `app/api/v1/auth.py`；领域操作与防滥用 guard `app/services/auth/account.py`；
用例编排 `app/services/auth/orchestration.py`；令牌服务（已按 purpose 泛化）
`app/services/auth/token_service.py`；两个新邮件模板 `app/services/email/renderer.py`。

## 交叉作废矩阵

| 触发事件 | 撤销范围 |
|---|---|
| 重置密码成功 / 改密成功 | 全部 refresh token + 该用户 active 的 `password_reset` 与 `account_deletion` 令牌 |
| 确认注销成功 | 全部 refresh token + 该用户**所有用途**的 active 令牌 |
| 签发任一用途新令牌 | 同用途旧 active 令牌（既有语义不变） |

「先发起注销又改了密码」的场景由第一行覆盖：改密自动作废未点击的注销确认链接。

## 邮箱验证不变量扩展

重置密码成功且令牌的 `sent_to_email` 等于用户当前邮箱时，顺带置 `email_verified = true`。
不变量表述已在 `CONTEXT.md`「邮箱验证」中扩展为：任何 TTL 内成功消费的、发往当前邮箱的
认证令牌都构成一次邮箱验证——不限于「验证邮件」这一种用途。

## 限流与 Redis 故障策略

对号入座邮箱验证一期的三种模式（实现均在 `app/services/auth/account.py`）：

| 端点 | 模式 | Redis 故障 |
|---|---|---|
| request-password-reset | 同 register：IP 限流 + 邮箱冷却（60s，按 purpose 独立计） | IP fail-open；冷却降级为数据库冷却，接口保持可用 |
| reset-password / confirm-account-deletion | 同 verify：IP 限流（复用 verify 限流参数，key 按 action 独立） | fail-open（高熵令牌不被 Redis 故障阻塞） |
| request-account-deletion | 同 resend：用户/邮箱冷却 + IP 限流 | fail-closed（429 + `Retry-After`） |
| change-password | 用户维度**失败尝试**限流（仅密码错误消耗额度）+ IP 限流 | fail-closed（防在线爆破） |

防枚举细节：request-password-reset 对不存在/已停用的邮箱同样占用冷却 key——429
出现与否不泄露注册状态。Redis 降级期间数据库冷却只覆盖已有令牌记录的邮箱，
不存在的邮箱降级期间无冷却（响应恒定，仅发信侧无影响，风险已接受）。

密码类端点的防爆破顺序：IP 限流在密码校验**之前**执行，持有被盗会话的攻击者
无法超窗口猜密码。change-password 的失败尝试计数是 `INCR + EXPIRE` 计数器
（`rate_limit.check_failure_budget` / `record_failure`），成功尝试不消耗额度。

## 新配置（已进 `.env.example` 与 `app/core/config.py`）

```env
AUTH_PASSWORD_RESET_TOKEN_TTL_SECONDS=1800
AUTH_ACCOUNT_DELETION_TOKEN_TTL_SECONDS=1800

AUTH_RATE_PASSWORD_RESET_REQUEST_IP_LIMIT=5
AUTH_RATE_PASSWORD_RESET_REQUEST_IP_WINDOW_SECONDS=3600
AUTH_RATE_PASSWORD_CHANGE_USER_LIMIT=5
AUTH_RATE_PASSWORD_CHANGE_USER_WINDOW_SECONDS=900
AUTH_RATE_PASSWORD_CHANGE_IP_LIMIT=10
AUTH_RATE_PASSWORD_CHANGE_IP_WINDOW_SECONDS=3600
AUTH_RATE_DELETION_REQUEST_IP_LIMIT=5
AUTH_RATE_DELETION_REQUEST_IP_WINDOW_SECONDS=3600
```

邮箱/用户冷却复用 `AUTH_EMAIL_VERIFICATION_COOLDOWN_SECONDS=60`，但按 purpose
独立计 key，不与验证邮件互相挤占。

## 邮件

两个新模板复用品牌化 HTML 卡片渲染器（`_render_card_html`，由验证邮件模板抽出，
外观不变）：

- `password_reset` — 链接指向 `{FRONTEND_APP_URL}/reset-password?token=...`
- `account_deletion` — 链接指向 `{FRONTEND_APP_URL}/confirm-account-deletion?token=...`，
  含「如非本人操作请立即修改密码」警示。

投递沿用既有 outbox 通道（claim/lease/重试/dead/sweep），排查与补投手段不变
（见邮箱验证交接文档「运维」节）。

## 注销语义与运维说明

- 注销 = 软停用：`users.is_active = false` + 全凭证吊销，会话/消息数据原样保留。
  物理清除（冷静期 + 周期任务）留作后续迭代，接续点见 ADR。
- **注销后恢复需运维手工处理**（`update users set is_active = true where id = ...`），
  数据未清除前可完整找回。将来若做「冷静期内自助恢复」，须设计显式恢复入口，
  **不得借道密码重置**——已停用账户申请重置的外部表现与不存在的邮箱完全一致
  （静默不发信），这是防枚举与防打扰的既定行为。
- 停用用户的执行面是既有机制：login / refresh / 当前用户依赖全部拒绝
  `is_active = false` 的用户,无新增访问控制。

## 上线注意事项

1. 生产 `.env` 增补上述新环境变量后 **force-recreate**（`restart` 不重载 env）：
   `docker compose -f compose.prod.yml up -d --force-recreate api celery-worker celery-beat`。
2. **前端页面就位前，重置/注销邮件内的链接是死链**（`/reset-password`、
   `/confirm-account-deletion` 页面单独一期）。匿名接口存在但前端不提供入口即可
   避免用户触达死链；勿在前端页面就位前宣传忘记密码功能。
3. 邮件仍是 at-least-once 语义（与验证邮件一致），本期不防重复发送。

## 验证

后端（先停 LLM worker 与 celery-worker 容器，避免抢占测试数据）：

```bash
docker stop ichat-worker-1 ichat-worker-2 ichat-celery-worker-1
uv run pytest          # API 层：tests/api/test_account_lifecycle.py（56 例）等
uv run ruff check app tests
uv run mypy app
```

端到端 smoke（dev，`EMAIL_PROVIDER=console`，2026-07-13 已执行）：

```bash
docker compose up -d --build
# A 流程：POST /request-password-reset → celery-worker 日志取链接 →
#   POST /reset-password → 新密码可登录、旧密码 401、旧 refresh token 401
# B 流程：POST /change-password → 全设备下线
# C 流程：POST /request-account-deletion（重输密码）→ 日志取链接 →
#   POST /confirm-account-deletion → login / refresh / me 全 401
# 防枚举：不存在邮箱恒定 200;冷却窗口内重复申请 429（存在/不存在一致）
```

### 2026-07-13 验收结果

- 后端全量：`410 passed`；ruff 全过；mypy 严格模式 81 个 source files 无错误。
- A 流程：申请重置 200 → console 邮件含 `/reset-password?token=...`（30 分钟提示）→
  重置 200 → 旧密码登录 401、新密码 200、重置前 refresh token 401、
  `/me` 返回 `email_verified=true`（顺带验证生效）。
- B 流程：改密 200 → 改密前 refresh token 401（当前设备同样被踢）→
  旧密码 401、新密码 200。
- C 流程：错误密码发起注销 400（不发信）；正确密码 200 → console 邮件含
  `/confirm-account-deletion?token=...` 与非本人操作警示 → 确认 200 →
  login / refresh / me 全 401；链接重复使用 400。
- 防枚举：已注销账户与不存在邮箱申请重置均恒定 200、冷却窗口内重复均 429、
  期间零封重置邮件发出（celery 日志核对）。
