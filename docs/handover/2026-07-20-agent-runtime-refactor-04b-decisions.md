# Handoff：agent 运行时再分层（04b）裁决定稿，待实施

日期：2026-07-20 · 分支：`refactor/agent-worker`

## 一句话状态

issue 03+04 交付后，所有者评审判定分层不符预期（kernel 含工程/业务代码）；本会话经 LangChain/LangGraph 对照评审与 grilling 逐项裁决，产出 **issue 04b**（`ready-for-agent`）及配套文档修订。**代码零改动**，下一步是实施 04b。

## 权威材料（不在本文重复）

- **04b issue（本次核心产出，实施依据）**：`.scratch/agent-runtime-refactor/issues/04b-agent-layering.md`——目标分层表、kernel/编排层/worker 范围、AgentEvent 契约、重试/取消机制、验收标准全在其中。
- 领域词汇：`CONTEXT.md`（本次新增「模型调用 vs 轮」，修正「agent 内核」定义）
- 模块边界：`docs/architecture/module-boundaries.md`（本次修订，**注意：描述的是 04b 目标态，超前于代码现状**，所有者知情认可）
- 上游交接：`docs/handover/2026-07-20-agent-runtime-refactor-issue03-04.md`（含本地验证流程与环境注意事项，实施时必读）
- 总 PRD：`.scratch/agent-runtime-refactor/PRD.md`

## 本次会话的关键裁决脉络（issue 里没有的"为什么"）

1. **所有者的核心修正**（推翻我的初版方案）：初版把通用 tool loop 放 kernel、编排层只拼参数。所有者指出正确映射是 LangChain 的 core/harness 分界——**循环属 harness（编排层），kernel 只有 building blocks**。未来 middleware/HITL 的复杂度必须着陆在编排层。
2. **生成器即边界**是第一原则：编排层 yield 宣告、worker 拉取工程化，由此化解"编排层似乎需要传输层"的担忧，不加中间层。
3. **取消对照 LangGraph 裁决**：cancel 语义在平台层（worker），库层只需取消安全；kernel 与编排层零取消词汇。
4. 词汇裁决均有 LangChain 同位素佐证：`stream_model_call`（对 `wrap_model_call`）、`RetryPolicy` 数据化（对 LangGraph retry_policy）、durability 三档（对 checkpointer 模式，已记入 issue 06）。
5. grilling 补漏的实现雷点（issue 已收录，实施时留意）：重试重启生成器的等价性依赖"零事件转发"守卫；取消必须 select 循环精确 cancel `__anext__` 而非整任务 cancel（否则丢缓冲 delta、打断 PG 写）；`ChatAgent.stream()` 可重入契约。

## 连带修订（已完成）

- issue 05：追加"标题组装迁编排层"验收条款（04b 对 `title.py` 只做机械适配）。
- issue 06：Blocked by 04 → **04b**；采用 durability 三档词汇。
- 已知限制单列：多 model call run 的 usage 少计为既有行为，04b 不修（所有者裁决保持口径），**尚未建独立小 issue，实施完可顺手补**。

## 下一步

实施 04b（在 06 之前；05 正交可并行）。波及面：`app/agent` 重写收敛、新建 `app/services/agents`、`app/worker/executor.py` 消费循环改造、`events.py` 拆迁、`tests/agent`/`tests/worker` 接口改写。验收以 issue 03/04 端到端脚本行为等价为判据（脚本用法见上游交接的验证章节）。

## 环境与操作注意

- Python 用 `uv run ...`；DB 集成测试前 `docker compose stop worker`，测后恢复。
- 分支尚未推送的提交与本次文档改动均未 commit——实施前先按 Conventional Commits 提交本批 docs/tracker 改动。

## Suggested skills

- `tdd`：编排层 `ChatAgent.stream()` 循环与 worker 消费循环适合 test-first（纯内存 fake 已有先例 `tests/agent/test_runtime.py`）。
- `verify`：实施完成后跑真实 API/SSE 端到端（复用 issue 03/04 脚本），不以单测代替运行时观察。
- `code-review`：收尾按 Standards + Spec 双轴复核（Spec 轴对照 04b issue）。
- `simplify`：大改动收尾检查层级与复用。
