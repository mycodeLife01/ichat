# 2026-05-17 真实 DeepSeek 端到端 Smoke 交接

## 本次完成

针对 MVP 后端（API + worker + postgres）跑了一次真实 DeepSeek 凭据下的端到端手工 smoke，覆盖：

1. 用户注册、登录、access token 使用。
2. Conversation 创建与列表校验。
3. Happy path：发消息 → 全量 SSE streaming → run `succeeded` → assistant message 物化。
4. SSE replay：用 `after_seq` 从已结束 run 中部断点重连，只返回剩余 event + terminal。
5. Streaming cancel：streaming 中途取消 → run `cancelled`，partial deltas 保留，无 assistant message。
6. Queued cancel：worker 离线时发消息，立即取消 → run 直接 `cancelled`，0 个 text_delta。worker 重启后未误 claim。
7. Invalid key failed path：临时用非法 `DEEPSEEK_API_KEY` 启动 worker，发消息 → worker 重试一次 → run `failed`，terminal event 持久化 DeepSeek 401 原文。
8. Recovery：恢复真实 key 后，新 run 正常 `succeeded`。

结论：MVP 全链路在真实 DeepSeek 凭据下走通，未发现需要立即修复的回归。

## 环境

- 本地直跑 `uvicorn` 与 `python -m app.worker`，未使用 docker compose 的 api/worker 服务。
- postgres 使用既有 `ichat-postgres-1` 容器（5432 暴露到本机）。
- `DATABASE_URL` 在启动命令里覆盖为 `postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat`；其余配置走仓库 `.env`。
- DeepSeek 配置（取自仓库 `.env`，保持原值未改写）：
  - `DEEPSEEK_BASE_URL=https://api.deepseek.com`
  - `DEEPSEEK_MODEL=deepseek-v4-flash`
  - `DEEPSEEK_THINKING_ENABLED=false`
- worker 配置：`RUN_LEASE_SECONDS=60`、`WORKER_POLL_INTERVAL_SECONDS=2`、`WORKER_HEARTBEAT_INTERVAL_SECONDS=10`。

注意：`DEEPSEEK_MODEL=deepseek-v4-flash` 看起来不是 DeepSeek 官方公开的 model id（公开 id 为 `deepseek-chat` / `deepseek-reasoner`），但本次调用 200 OK 且正常返回流式中文输出，未观察到 model 相关报错。用户明确要求保持原值，未改动。

## 测试身份

- username: `jk`（zsh `USERNAME` 是特殊参数无法被本地 `USERNAME=` 覆盖，导致注册时实际写入 shell 已存在的 `jk`；email/password 不受影响）
- email: `smoke_1779021151@example.com`
- user id: `2161`
- conversation: `1716`（title `smoke 2026-05-17`）

## Run 一览

| run id | 场景 | prompt 摘要 | 终态 | latest_seq | terminal type | terminal_at (UTC) | 备注 |
|---|---|---|---|---|---|---|---|
| 1487 | Happy path | 中文 150 字“春天的早晨” | `succeeded` | 130 | `run_succeeded` | 2026-05-17T12:33:40.392168Z | 128 个 text_delta；usage `prompt=34 / completion=128 / total=162` |
| 1488 | Streaming cancel | 中文 1500 字“江南雨夜的回忆” | `cancelled` | 1265 | `run_cancelled` | 2026-05-17T12:34:33.120619Z | 取消时 partial draft 已累计 1826 字符；无 assistant message |
| 1489 | Queued cancel | 占位文本（worker 离线时投递） | `cancelled` | 1 | `run_cancelled` | 2026-05-17T12:35:16.560768Z | 0 个 text_delta；worker 重启后未被 claim |
| 1490 | Invalid key | 占位文本（invalid `DEEPSEEK_API_KEY`） | `failed` | 2 | `run_failed` | 2026-05-17T12:36:13.693845Z | worker 重试 1 次后失败；error code `deepseek_http_error` + 401 message 持久化 |
| 1491 | Recovery sanity | “Smoke recovery probe” | `succeeded` | 1545 | `run_succeeded` | 2026-05-17T12:37:21.999002Z | 用真实 key 复跑，验证 worker 恢复正常 |

## 详细验证

### 1. Happy path（run 1487）

- `POST /api/v1/conversations/1716/messages` 立刻返回 run `queued`、user message id `1774`。
- `GET /api/v1/runs/1487/events?after_seq=0` 先发 `run_started`（seq=1），然后是 128 个 `text_delta`（seq=2..129），最后 `run_succeeded`（seq=130）。
- 全程 seq 严格单调递增，无跳号、无回退。
- `GET /api/v1/runs/1487/state`：
  - `status=succeeded`
  - `latest_seq=130`
  - `draft_text` 累计 174 字符（assistant 文本）
  - `terminal_event.payload.usage`：`prompt_tokens=34`, `completion_tokens=128`, `total_tokens=162`
- `GET /api/v1/conversations/1716` 出现新 assistant message id `1775`、`role=assistant`、`position=2`、`run_id=1487`，`content` 字面完全等于 `draft_text`。

### 2. SSE replay（after_seq=125 on run 1487）

- `GET /api/v1/runs/1487/events?after_seq=125` 立即返回：
  - text_delta seq 126、127、128、129
  - run_succeeded seq 130
- 连接随 terminal event 自动关闭，未触发任何 provider 调用。

### 3. Streaming cancel（run 1488）

- 发完消息后立刻打开 SSE，约 1.5 s 后调用 `POST /api/v1/runs/1488/cancel`。
- Cancel API 返回 `{"data": {"status": "ok"}}`。
- 由于 worker heartbeat 间隔 10 s，provider stream 在 cancel 请求后仍继续累计 deltas，直到 worker 下一次 heartbeat 观察到 `cancelling`，关闭 provider stream 并写入 `run_cancelled`。
- 最终 `latest_seq=1265`，terminal `run_cancelled`，partial draft 1826 字符。
- 对话详情中未物化 assistant message（消息列表只新增了 user message id 1776，对应 run 1488）。
- 紧接着再次 `POST .../cancel` → 仍返回 `{"data": {"status": "ok"}}`，`/state` 中 `latest_seq` 与 `terminal_event.seq` 不变，幂等成立。

观察：本次 cancel → terminal 的实际 wallclock 间隔接近 heartbeat 间隔（10 s）。MVP 设计文档说明 cancel 由 worker 在 heartbeat 之间观察 `cancelling` 触发关流，因此该延迟符合预期。若后续希望更快取消可调小 `WORKER_HEARTBEAT_INTERVAL_SECONDS`。

### 4. Queued cancel（run 1489）

- 流程：先 `kill` 当前 worker 进程；再发消息（API 处于无 worker claim 状态，run 保持 `queued`）；调用 `POST /api/v1/runs/1489/cancel`。
- Cancel API 立刻返回 `{"data": {"status": "ok"}}`。
- `/state`：`status=cancelled`，`latest_seq=1`，`terminal_event.type=run_cancelled`，`payload={}`，`draft_text=""`。
- 重启 worker 后，新 worker 启动日志只打 `Worker starting`，未输出任何 claim/stream 相关日志；`/state` 重读仍为 `cancelled`，未被错误重启执行。

→ 这条路径确认 `cancel_owned_run()` 在 queued 分支会清空 `lease_owner`、`lease_expires_at`，recovery scheduler 不会把它当作过期 lease 重新捞起。

### 5. Invalid key failed path（run 1490）

- 启动一个临时 worker，`DEEPSEEK_API_KEY=sk-invalid-smoke-test-key-0000000000000000` 覆盖。
- 发消息后等待约 12 s。
- Worker 日志：
  - `Worker starting`
  - `Retrying provider stream once` `code=deepseek_http_error`（验证“首个 delta 之前重试一次”的策略）
- `/state`：
  - `status=failed`
  - `latest_seq=2`（`run_started` seq=1，`run_failed` seq=2）
  - `terminal_event.payload.code=deepseek_http_error`
  - `terminal_event.payload.message`：`DeepSeek returned 401: {"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid",...}}`
  - `draft_text=""`，未物化任何 partial 文本。
- 终止该 worker，重新用真实 key 启动 worker；下一个 run（1491）顺利 `succeeded`，证明 provider 配置 reload 正常。

## 验证命令（用于复跑）

启动栈（假设 postgres 已在 docker compose 启动）：

```bash
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' uv run alembic upgrade head
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 &
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' uv run python -m app.worker &
```

健康检查：

```bash
curl -s http://127.0.0.1:8000/healthz
```

完整 smoke 流程的具体 curl 调用与 payload 见 `/tmp/ichat-smoke/`（本次执行产物）。后续复跑时建议改用临时随机邮箱避免冲突，并直接照本文档“详细验证”章节顺序复现。

## 本次刻意未做

- 未把 smoke 步骤脚本化为仓库内 fixture 或 makefile target；当前仍是一次性手工流程。
- 未改动 `.env` 中的 `DEEPSEEK_MODEL`（保持 `deepseek-v4-flash`，遵循用户决定）。
- 未引入 docker compose 内的 `api` / `worker` 服务启动方式；本次以本地 `uv run` 直接跑（因为 compose 的 api/worker 默认 host 是 `postgres`，且需要本地 build 镜像）。
- 未在 cancel API 上加 rate limit；不在本次范围。
- 未触达 regenerate 路径；该模块仍未实现，按计划属于下一步开发任务。
- 未把 invalid key 路径自动化进 worker 测试套件（已有 fake provider 覆盖）。

## 当前项目进度

已完成（基于上次交接 + 本次 smoke）：

1. 项目骨架、模块边界、Docker Compose 和基础依赖。
2. FastAPI app factory、配置、日志、错误类型、健康检查和数据库 session 基础设施。
3. Alembic 基础环境和首个业务迁移。
4. MVP 核心 ORM models。
5. 统一成功响应 envelope。
6. 用户注册、登录、refresh token 轮换、登出和当前用户依赖。
7. Conversation 创建、列表、详情、重命名和软删除。
8. 提交 user message 并创建 queued run。
9. 每个 conversation 一个 active run 的 service/API 覆盖。
10. Run event 写入、递增 `seq` 和持久化 replay 查询。
11. Run state API。
12. SSE replay/tail endpoint，terminal event 后自动结束。
13. Provider interface、DeepSeek streaming adapter、fake provider。
14. Worker claim、lease、heartbeat、provider stream 执行 loop 和 recovery scheduler。
15. Run cancellation API、service 取消写路径、worker 取消优先级保证。
16. 真实 DeepSeek 凭据下端到端 smoke 验证（本次）。

仍未完成：

1. Regenerate 归档规则。
2. 批量取消、cancel rate limit。
3. SSE `Last-Event-ID`。
4. Smoke 流程脚本化 / 进 CI 的可选自动化。

## 接下来的开发任务

建议下一步：

1. 实现 regenerate（`POST /api/v1/messages/{message_id}/regenerate`），并补 archive 规则的 service + API 测试。
2. 接入前端取消按钮，串通 `POST /cancel` → `/state` 重新拉取 → `/events` 终态结束流程；可参考本次 smoke 数据点验证 UI 行为。
3. 视需要把 streaming cancel 的 worker 检测延迟（当前与 `WORKER_HEARTBEAT_INTERVAL_SECONDS` 同阶）调小，或在 worker heartbeat 之外加 cancel-aware 短轮询；若不调，则在前端文案上明示“取消可能需要数秒”。
4. 若 `DEEPSEEK_MODEL=deepseek-v4-flash` 是临时灰度名，建议尽快回到 `deepseek-chat` 等公开 id，避免后续 DeepSeek 端禁用导致 smoke 静默回归。

## Git 状态

- 本次未改动任何 `app/` 代码或测试；仅新增本交接文档。
- 写入本交接文档前，工作区 clean（与上次 `daff88e chore: ignore .obsidian workspace metadata` 后状态一致）。
- 写入后，当前新增 `docs/handover/2026-05-17-deepseek-smoke.md` 待提交。

## 注意事项

- 文档使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- 本次 smoke 在生产 DeepSeek 账户上消费了真实 token（粗略估算 < 4000 tokens，绝大部分为 run 1488 / 1491 的中文长输出）。后续复跑建议同样使用临时邮箱，避免污染线上观测视图。
- `.env` 中 `DEEPSEEK_API_KEY` 不可外传；本文档及 `/tmp/ichat-smoke/` 已避免落明文。
- `DEEPSEEK_MODEL` 当前保持 `deepseek-v4-flash`，若后续报错请参考“接下来的开发任务”第 4 条回退 `deepseek-chat`。
