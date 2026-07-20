# Handoff：agent 运行时再分层（04b）实施完成

日期：2026-07-20 · 分支：`refactor/agent-worker`（有 upstream，**4 个提交未推送**）

## 一句话状态

issue 04b（kernel 收敛为 building blocks、编排层独立、worker 纯工程化）已按裁决**全部实施并验证**（`pytest` 445 passed、`ruff`、`mypy` 全绿，含新增内核纯度边界测试）。代码分两个提交落在当前分支，未推送。下一步是 issue 06（先于它做 04b 是刻意安排，见 04b 排期）。

## 本次提交（未推送）

- `6766b05 refactor(agent): re-layer kernel/orchestration/worker (issue 04b)`——04b 主体。
- `e975c77 refactor(search): keep the kernel free of config via a pure package root`——收尾：消除内核经 `app/search/__init__.py` 对 `app.core.config` 的**传递性**依赖，并清理 issue 03/04 残留的空 legacy 目录。

两条提交的 message 已完整记录改动清单与理由，不在此重复。`git show 6766b05`、`git show e975c77` 即可看全貌。另有两个更早的未推送提交（`ebef067` 模型策略、`b631cfc` 04b 决策文档）。

## 权威材料（不在本文重复）

- **实施依据**：`.scratch/agent-runtime-refactor/issues/04b-agent-layering.md`（目标分层表、AgentEvent 契约、重试/取消机制、验收标准）
- **裁决脉络（为什么这么分）**：`docs/handover/2026-07-20-agent-runtime-refactor-04b-decisions.md`
- **上游交接（本地验证流程、环境注意）**：`docs/handover/2026-07-20-agent-runtime-refactor-issue03-04.md`
- 模块边界（已描述 04b 目标态）：`docs/architecture/module-boundaries.md`
- 总 PRD：`.scratch/agent-runtime-refactor/PRD.md`

## 最终落地形态（与 04b issue 一致，仅记差异/要点）

- 内核 `app/agent`：`stream_model_call`/`execute_tool`（`primitives.py`）、AgentEvent 词汇（`events.py`）；删 `runtime.py`（AgentRunner 等）；`DeepSeekProvider` 与 web_search 收窄为窄参（`WebSearchConfig`）；`context.py`/`prompts.py`/`registry.py` 迁至编排层。
- 编排层 `app/services/agents`（新）：`build_chat_agent` + `ChatAgent.stream()`（循环归此，可重入）、`RetryPolicy`、`assistant_metadata` 钩子内化 `SourceRegistry`。
- Worker `app/worker/executor.py`：消费 `agent.stream()`（seq/映射/sink）、重试=整体重启生成器（守卫「未向 sink 转发」）、取消=select 循环 cancel `__anext__` + `aclose` + 照常 `flush`；`CancellationToken` 换裸 `asyncio.Event`。
- `events.py` 拆迁：`RunEvent`/`RunEventType`→`app/services/runs/events.py`，`EventSink`→`app/worker/event_sink.py`；`tool_provider_names`→`tool_backend_names`（SSE wire `"provider"` 字段名不动）。

### 实施中作出的、issue 未逐字规定的取舍（下一手需知）
1. `build_chat_agent(settings, history, options, resolve_provider=…, now=…)`——比 issue 的 `(settings, history, options)` 多两个 keyword-only 参数，作为 provider 注入与确定性时间的测试接缝（executor 原本就注入 resolve_provider）。
2. 重试守卫用「未向 sink 转发任何事件」判定，等价于旧 `not had_output and not transcript`；理论上 `ToolCallDone-then-error`（真实适配器不可达）会有细微差异，已按 04b 裁决采纳该守卫。
3. context/tool 组装失败统一映射 `context_build_error`（旧 `tool_setup_error` 合并，无测试断言该区分）。
4. `web_search` 仍留内核 `tools/`（module-boundaries 目标态如此），故其 `Settings` 依赖收窄为 `WebSearchConfig`，而非移出。

## 连带产出

- 新建 `.scratch/agent-runtime-refactor/issues/09-multi-call-usage-undercount.md`：记录既有「多 model call run usage 少计」限制（04b 不修，所有者已裁决保持口径）。
- 内核纯度**传递性**断言：`tests/agent/test_boundaries.py::test_kernel_does_not_transitively_import_config_db_or_services`（子进程内 import 内核，断言 `sys.modules` 无 config/services/models/db）。

## 环境状态（重要，与本地验证直接相关）

本会话开始时 Docker 完全未运行。为跑 DB 集成测试我做了：
1. 拉起 `postgres`；dev 库卷停在 `20260714_0010`，**缺 `20260718_0011`（transcript blocks）**——用本地代码 `DATABASE_URL=…@localhost:5432/… uv run alembic upgrade head` 补到 head。（compose `alembic upgrade head` 会因 `.env` 用容器主机名 `postgres` 而 getaddrinfo 失败，需覆盖 `DATABASE_URL` 为 localhost，或用 `docker compose run --rm migrate`。）
2. compose 的 `migrate`/`api`/`worker` 镜像是**旧构建**（早于 0011、早于 04b），`migrate` 会报 `Can't locate revision '20260718_0011'`。已 `docker compose build migrate api worker` 重建，现镜像跑的是 04b 代码。
3. 现状：`postgres` healthy、`worker-1`/`worker-2` 在新镜像上正常运行（`RunQueuedListener started`，无异常）。

**下一手若换机器/重置卷**：先 `docker compose run --rm migrate`（镜像已含 0011），再起 worker。跑 DB 测试前 `docker compose stop worker`，测后 `docker compose up -d worker`（见 [[backend-tests-share-dev-db-with-workers]] 记忆）。

## 验证命令（本次已跑，全绿）

```bash
docker compose stop worker
uv run pytest                 # 445 passed
uv run ruff check .
uv run mypy app               # 100 files, no issues
docker compose up -d worker
```

单跑纯内存套（无需 DB）：`uv run pytest tests/agent tests/services/agents -q`（58 passed）。

## 下一步 frontier

- **issue 06（Redis Stream 传输 + checkpoint 降级）**：04b 已固化 `ChatAgent.stream()`↔worker 消费循环↔`EventSink` 接口，06 的 `RedisStreamSink`/`FanoutSink` 应实现 `app/worker/event_sink.py::EventSink`（与 `PostgresEventSink` 并列）。06 的 Blocked-by 已改挂 04b，采用 `exit/async/sync` durability 三档词汇。
- **issue 05（标题生成迁 Celery）**：正交，先后皆可。05 新增验收条款——标题 LLM 组装迁入编排层（标题 agent 构建函数），`app/worker/title.py` 现状为「机械适配」的暂留（04b 已如实记录）。
- **推送**：4 个未推送提交，推送后 CI 会构建镜像；生产部署见 `docs/deployment.md`。

## Suggested skills

- `tdd`：issue 06 的 Redis sink / checkpoint / fallback / cursor 组合适合 test-first（`PostgresEventSink` 的纯内存批窗口测试 `tests/worker/test_executor_batching.py` 是先例）。
- `verify`：06/05 完成后走真实 API/SSE 端到端（复用 issue 03/04 脚本，见上游交接验证章节），不以单测代替运行时观察。
- `code-review`：收尾按 Standards + Spec 双轴复核（Spec 轴对照对应 issue）。
- `diagnosing-bugs`：若 Redis 降级、断线恢复或 seq 坐标出现时序问题，用系统化诊断循环。
