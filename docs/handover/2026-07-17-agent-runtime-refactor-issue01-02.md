# Handoff: iChat agent 运行时重构 — issue 01+02 已完成并提交

日期：2026-07-17 · 分支：`refactor/agent-worker` · 工作区：`D:\projects\jk\ichat`（干净）

## 一句话状态

PRD 交付一的前两张 ticket（后台任务约定文档、agent 内核类型层 + DeepSeek openai-SDK 适配器）已实现、全量校验通过并落为两个提交：`06f1784`（docs）、`5505bc8`（agent kernel）。下一步自然是 issue 03（转写 blocks 持久化）→ issue 04（AgentRunner 抽取 + worker 薄化）。

## 权威材料（不在此重复，先读）

- PRD 与全部 ticket：`.scratch/agent-runtime-refactor/PRD.md`、`.scratch/agent-runtime-refactor/issues/01..08-*.md`
  - PRD 含**术语表（命名裁决，实施时严格遵守）**与 14 条设计决策，是最高约束。
- 两个提交的 message 记录了关键实现决策：`git show 06f1784 5505bc8 --stat`
- 新文档：`docs/architecture/background-tasks.md`（issue 01 产物）
- 项目规则：`CLAUDE.md`（中文交流、Conventional Commits、跑 pytest 前停 worker 等）

## 本次会话做了什么（超出提交 message 的上下文）

### 关键策略决策（用户拍板）

**并存/expand 策略**：`app/agent/` 新内核与旧 `app/providers|context|prompts|tools` 并存；worker 仍跑旧路径，存量测试零改动。旧包的删除属于 issue 04。这是为了满足 issue 02 验收「存量测试不改断言」与「重写适配器」之间的张力。

### 用户三轮架构批评（均已采纳落地，理解其理由对后续工作重要）

1. **内核 context 不得碰 DB**：`app/agent/context.py` 最初直接吃 `session/run_id` 并 import ORM——被批评为业务泄漏进内核。已改为纯函数 `build_context(*, system_prompt, history, budget_tokens, count_tokens)`；DB 读取/转写回放下沉到 `app/services/runs/history.py` 的 `load_conversation_history(session, run_id) -> list[Message]`。这是对 PRD 字面「build_context 迁入 agent 包」的有依据偏离（依据 User Story 8：runtime 纯内存可测）。
2. **Tool 抽象不得含特例字段**：`ToolResult` 曾有 `sources/payload/error_code/message` 一等字段、并自造了 PRD 术语表没有的 `ToolContext`——均删。现为 `content + is_error + metadata(dict)`；`Tool.execute(arguments) -> ToolResult`；web_search 专有依赖（settings/client/SourceRegistry）经 `WebSearchTool.__init__` 注入，专有输出走 `metadata`。
3. **接口用扁平 `list[Message]`，不用 `list[list[Message]]`**：turn 分组只是「裁剪不切断 tool_call↔tool_result」的内部约束，不该暴露为 API 概念（对齐 LangChain `trim_messages` / provider 消息数组）。turn 边界现由内部推导：「含非 ToolResultBlock 内容的 user 消息」即真实用户轮次起点。

→ **模式**：用户对抽象纯度极敏感——内核不得被后端业务或单个工具反向污染；自造 PRD 术语表之外的概念前要三思。后续 issue 03/04 请延续此标准。

### 其他要点

- 新增依赖 `openai==2.46.0`（`uv add openai`）。
- DeepSeek 适配器 capabilities：`supports_tool_history=False, supports_reasoning=True`；tool 历史剥离在 `_messages_to_wire(strip_tool_history=...)`，由「本次请求是否注册 tools」+ capability 决定。
- 已做真实端到端 smoke（工具关/开各一次，真实 DeepSeek+Tavily，均通过）；smoke 脚本已按约删除，issue 03/04 若需可仿照重建（当时路径 `scripts/agent_smoke.py`，git 未入库）。
- `tests/agent/fake.py` 的 `FakeProvider`（StreamEvent 版）是 issue 04 AgentRunner 纯内存测试缝的基石，已就位。
- 全量 pytest 中 `tests/services/avatars/test_storage.py::test_avatar_object_keys_are_random_and_identity_free` 偶发 flaky（随机 UUID 含子串 "42"），与本次无关，重跑即过。
- 终端输出中文在 GBK 控制台显示乱码属正常，数据本身正确。

## 环境/操作注意

- 用 `uv run ...` 跑一切 Python（裸 `python` 走 pyenv 报错）。
- **跑后端 pytest 前 `docker compose stop worker`，跑完 `start worker`**（worker 会抢占测试 run，既有约定，memory 里也有记录）。
- DB 集成测试默认连 `postgresql+asyncpg://ichat:***@localhost:5432/ichat`（compose 内 postgres）。
- 校验三件套：`uv run pytest` / `uv run ruff check .` / `uv run mypy app`。
- 与用户交流用中文；不主动进 plan mode；不建 worktree。

## 下一步（按 PRD 依赖链）

1. **issue 03**（`03-transcript-blocks-persistence.md`）：转写表加 `blocks` JSONB 列（expand-contract），新行只写 blocks，旧行读取时转换（转换逻辑归 DeepSeek 适配器）；1 消息=1 行。注意 `app/services/runs/history.py::_transcript_row_to_message` 目前手写了 wire→blocks 转换——issue 03 应把它收编/复用到正式转换路径。
2. **issue 04**（`04-agent-runner-extraction.md`）：`AgentRunner`/`RunConfig`/`RunResult`/`CancellationToken`/`EventSink`；worker 薄化；届时删除旧 `app/providers|context|prompts|tools` 并更新其测试（该批测试改动需在 PR 逐条说明）。
3. issue 05（标题迁 Celery）只依赖 02，可与 03 并行；`Provider.generate` sync 路径已备好。

## 建议调用的 skills

- `code-review`：动手 issue 03/04 前先 review `5505bc8` 以来的分支变更（standards + spec 双轴）。
- `tdd`：issue 04 的 AgentRunner 是 PRD 钦定「最高价值纯内存测试缝」，适合 test-first（FakeProvider/FakeSink/受控 CancellationToken 覆盖多轮工具循环、三种取消时机、异常、限额）。
- `verify`：issue 04 接线 worker 后端到端驱动真实对话验证。
- `simplify`：大改动收尾时清理。

## 脱敏说明

本文不含密钥。真实 DeepSeek/Tavily key 在项目 `.env`（勿入库勿外发）。
