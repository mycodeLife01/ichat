# Handoff：iChat agent 运行时重构 — issue 03+04 完成

日期：2026-07-20 · 分支：`refactor/agent-worker`

## 一句话状态

交付一的 issue 03（transcript blocks expand-contract）与 issue 04（AgentRunner 抽取、worker 薄化）已实现并完成全量测试及 HTTP/SSE 端到端验证；旧 `app/providers|context|prompts|tools` 包已删除。代码已按可构建边界拆分提交，本文所在文档提交完成后将统一推送当前分支。

## 本次提交记录

- `fe0a38d`：`chore(agents): update subagent model policy`（会话开始前已有的独立配置修改）
- `28706e0`：`refactor(agent): persist blocks and extract AgentRunner`（issue 03+04 cohesive runtime 交付）
- 文档、tracker 与本交接由包含本文的 `docs(architecture)` 提交承载。

## 权威材料

不在本文重复 PRD、决策和验收原文：

- 总 PRD 与术语裁决：`.scratch/agent-runtime-refactor/PRD.md`
- issue 03：`.scratch/agent-runtime-refactor/issues/03-transcript-blocks-persistence.md`
- issue 04：`.scratch/agent-runtime-refactor/issues/04-agent-runner-extraction.md`
- issue 01+02 交接：`docs/handover/2026-07-17-agent-runtime-refactor-issue01-02.md`
- 模块边界：`docs/architecture/module-boundaries.md`
- 领域词汇：`CONTEXT.md`

## 最终实现边界

### Issue 03：provider-neutral transcript

- Alembic 新增 `run_provider_messages.blocks JSONB NULL`，不回填、不删除旧列。
- 新写入只写 `role + blocks`，旧 wire 列保持 NULL；同一工具轮的多个结果存为一个 user message blocks 数组。
- 旧行 `blocks IS NULL` 时，由 DeepSeek 适配器负责 wire → blocks 转换，服务层不解释 provider wire format。
- 关键入口：
  - `alembic/versions/20260718_0011_add_transcript_blocks.py`
  - `app/services/runs/transcript.py`
  - `app/agent/providers/deepseek.py::message_from_wire`
  - `app/services/runs/history.py`

### Issue 04：纯 AgentRunner + worker 适配器

- `app/agent/runtime.py` 只依赖 Provider、ToolRegistry、EventSink、CancellationToken，不 import DB、ORM 或业务 service。
- `AgentRunner` 负责 provider 流、多轮工具调用、重试、工具异常/限额、取消和内存 seq；输出 `RunResult.transcript`。
- `run_started` 与终态事件仍由现有 run lifecycle 写入；runner 从已存在的 seq 之后发射 delta 与 `tool_call_*`。
- `app/worker/event_sink.py::PostgresEventSink` 保留本阶段 PG batching，并把内核工具 metadata 映射为冻结的外部 SSE payload。
- worker 负责加载历史/组装 RunConfig、heartbeat 驱动 cancellation、终态转换、一次性 transcript 落库和 assistant materialize；`app/worker/executor.py` 已从约 1100 行缩减到约 330 行。
- heartbeat 续租增加 worker owner 校验，租约被其他 worker 接管时取消当前 runner。
- 标题生成仍在原调用点内联执行，但已切到新 Provider `generate()`，通过 `asyncio.to_thread` 避免阻塞事件循环；迁 Celery 仍属于 issue 05。
- `app/search` 保持独立基础设施，并以 `SearchError` 取代对旧 LLM provider 错误类型的反向依赖。

## Legacy 删除与测试迁移

已删除代码包：

- `app/providers/`
- `app/context/`
- `app/prompts/`
- `app/tools/`

其重复测试目录同步删除；等价和新增覆盖集中到 `tests/agent/`、`tests/services/runs/` 与 `tests/worker/`。

存量测试改动需要在 PR/提交说明中明确：

1. import/signature 类断言迁到新的 Message/Provider/StreamEvent 词汇。
2. transcript 内部列断言按 issue 03 的明确持久化契约更新。
3. web-search 自定义 fake 改为新协议的 `ReasoningDelta + ToolCallDone + StreamDone`；真实旧适配器本就会流出 reasoning delta，因此不是生产 SSE 行为新增。
4. 随 legacy 源包删除的重复测试由 `tests/agent/test_*` 和新增 `tests/agent/test_runtime.py` 接替。

## 验证证据

最终工作树执行：

```bash
docker compose stop worker
uv run pytest
uv run ruff check .
uv run mypy app
git diff --check
docker compose up -d worker
```

结果：

- `438 passed`（34 条既有 warning）
- Ruff 全量通过
- Mypy：97 个源文件无问题
- `git diff --check` 通过
- Alembic dev 库位于 `20260718_0011 (head)`
- API、PostgreSQL、两个 worker 副本已恢复运行

端到端验证没有调用真实 DeepSeek/Tavily：使用本地 OpenAI-compatible SSE + Tavily-compatible 假服务，通过真实 API、PostgreSQL、worker 和 SSE socket 驱动：

- 普通对话：`run_started → text_delta → run_succeeded`
- web search：`run_started → reasoning_delta → tool_call_started → tool_call_succeeded → text_delta → run_succeeded`，assistant metadata 含来源，transcript roles 为 `assistant → user → assistant`
- 流中取消：首个 reasoning delta 后取消，约 41ms 后收到 `run_cancelled`
- `after_seq=1` 只回放 delta 与终态
- 对已取消 run 再次取消仍返回成功，保持幂等
- 新 transcript 行均有 blocks，legacy wire 列均为 NULL

项目本地验证流程记录在 `.claude/skills/verify/SKILL.md`。注意：若 PostgreSQL 容器被重建而 API 未重启，旧 LISTEN 连接会失效，SSE 将表现为约 5 秒 fallback polling；重建或重启 API 可恢复即时 NOTIFY，这不是 AgentRunner 延迟。

## 环境与操作注意

- Python 命令继续使用 `uv run ...`。
- DB 集成测试前停止 Docker worker，测试后恢复。
- 本次端到端验证创建的临时用户和会话已在脚本结束时级联清理。
- 未向仓库写入或外发任何密钥；本文不包含凭据。
- 会话开始前 `CLAUDE.md` 已有 subagent model policy 修改；该修改被保留，并应与本次架构文档改动按独立功能处理。

## 下一步 frontier

- issue 05：标题生成迁 Celery；只依赖 issue 02，现可直接实施。
- issue 06：Redis Stream 传输与 checkpoint 降级；依赖 issue 04，现已解除阻塞。
- issue 08 依赖 issue 06；issue 07 的执行时机仍由所有者决定。

若优先降低 worker 尾部延迟与完善可重试性，先做 issue 05；若优先解决 PG delta 写放大和 SSE 读放大，直接进入 issue 06。

## Suggested skills

- `code-review`：提交后按 Standards + Spec 双轴复核 issue 03/04 最终分支。
- `tdd`：issue 06 的 Redis sink、checkpoint、fallback 与 cursor 组合适合 test-first。
- `verify`：issue 05/06 完成后通过真实 API/SSE surface 驱动，不以测试代替运行时观察。
- `simplify`：issue 06 大改动收尾时检查复用、层级和不必要复杂度。
- `diagnosing-bugs`：若 Redis 降级、断线恢复或 seq 坐标出现时序问题，使用系统化诊断循环。
