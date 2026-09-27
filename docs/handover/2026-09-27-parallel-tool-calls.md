# 同一 turn 内工具调用并发执行 交接

日期：2026-09-27

分支：`feat/parallel-tool-calls`

相关文档：[实施计划](../plans/2026-09-27-parallel-tool-calls.md)、[Run 耗时规格](../specs/2026-09-27-run-timing.md)、[thinking header 几何回归](2026-08-31-thinking-header-geometry-shift.md)、[web search tool](2026-06-11-web-search-tool.md)

## TL;DR

- 模型在同一个 assistant turn 里发出的多个工具调用，原来逐个串行执行，现在并发执行。工具阶段耗时从"各次之和"降为"约等于最慢一次"。改动前 eval：每多一次调用增加约 2.2s；一轮 3–5 次调用时，端到端加速约 1.5–2×。
- 事件顺序固定为：先按调用顺序发出全部 `ToolCallStarted`，整批完成后再按调用顺序发出全部 `ToolCallFinished`。SSE payload 仅在并发批次上新增字段：`tool_call_started` 带 `batch_size`，`tool_call_succeeded/failed` 带 `batch_source_count`。单次调用的 payload 不变，worker seq 仍然连续。
- 并发上限由新配置 `TOOL_CALL_MAX_CONCURRENCY` 控制，默认 4，按 run 生效。`WEB_SEARCH_MAX_TOOL_CALLS` 不变。
- 同期完成：web_search 总超时、Tavily 进程级连接池复用、前端文案"正在搜索 N 项"。

## 行为与实现

### Agent 循环（`app/services/agents/chat_agent.py`）

1. **准入**：按调用顺序判定。unknown tool 和超出 `max_tool_calls` 的调用直接生成错误结果，与改动前一致，且不占并发槽位。
2. **执行**：准入调用先按顺序 yield `ToolCallStarted`，然后通过 `asyncio.gather` 并发执行。每个 run 有一个 `asyncio.Semaphore(max_tool_concurrency)`。`_timed_execute` 只计量执行本身，不包含等待槽位的时间。
3. **收尾**：整批完成后，按调用顺序 yield `ToolCallFinished(elapsed_ms=...)`，并按同一顺序构造 `ToolResultBlock`。

事件只从 generator 内 yield，worker `_consume_agent` 串行分配 seq，并发不会影响 seq 分配。取消 run 时，`gather` 中在飞的任务会一并取消。

**引用编号（Q1 已确认）**：来源注册发生在各次 web_search 完成时，所以同批次的 citation id 按完成顺序分配，不按调用顺序。已确认可以接受。

**同一 URL 的内容以正文为准**：注册按完成顺序进行。带 `extract` 的调用要先搜索再抽取，通常比同批的普通搜索慢，所以同一个 URL 往往先被普通搜索以摘要形式注册。
- 串行执行时，这个 URL 由调用顺序靠前的那次注册；改成并发后，变成由先完成的那次注册。如果不处理，抽取到的正文会被丢掉。
- 现在 `SourceRegistry.register`（`app/search/postprocess.py`）在遇到已有记录时，如果已有记录只有摘要（`SourceRecord.extracted=False`），而本次有非空的抽取正文，就原地替换 snippet 和 title，id 不变。
- 已经是正文的记录不会被后续调用覆盖；空的抽取结果不会替换摘要。
- 先完成的调用已经发给模型的证据和事件摘要不会改变。抽取调用自己的证据，以及最终写入消息的 sources 元数据，使用的都是正文。

### 计时（`app/worker/timing.py`）

- `ToolCallStarted` 切到 `tool` 相位，`ToolCallFinished` 切回 `model_wait`。因此 `phases.tool` 记录的是整批墙钟时间。
- `tools[].ms` 取自 `ToolCallFinished.elapsed_ms`，即每次调用自身的耗时。缺失时记 0。`sum(tools[].ms)` 可以大于 `phases.tool`，规格 §3.2 已同步。
- `elapsed_ms` 只用于计时，不进入事件 metadata，也不进入 SSE。

### web_search 总超时（`app/agent/tools/web_search.py`）

`execute` 用 `asyncio.timeout(web_search_total_timeout_seconds)` 包住整个 `run_web_search`。超时时返回 `timeout` 错误结果，内容为 "Web search timed out. Continuing without live results."。来源在全部请求完成后才注册，所以超时不会留下部分来源。外层取消照常传播。这个超时防止一个挂起的调用拖住整批。

### Tavily 连接池（`app/search/tavily.py`）

- 未注入 transport 时，所有请求共用一个进程级 `httpx.AsyncClient`，懒创建。client 已关闭或事件循环变化时会重建。
- 连接上限 = `worker_max_inflight_runs × tool_call_max_concurrency`。超时按请求传入：read 使用调用方给出的秒数，connect 为 5s。
- 注入 transport 的测试路径不变，仍然每次调用新建 client。
- worker 退出时，`run_worker_loop` 的 finally 调用 `aclose_search_clients()`（`app/search/registry.py`）。

### "正在搜索 N 项"

- 批次大小由后端给出：`ToolCallStarted.batch_size` 等于本轮准入调用数，被拒绝的调用不计入。worker 写入 `tool_call_started` payload，由 `external_tool_payload` 输出，只有 > 1 时才带上，单次调用的 payload 不变。
- 前端 `useRunStream.ts` 的 `toolStateFromEvent` 把 `batch_size` 映射为 `running_count`；`get_run_state` 的 `_tool_state_from_event` 做同样映射。第一个 started 事件就显示"正在搜索 N 项"，刷新恢复与实时流一致。
- 为什么不在前端计数：最初版本由前后端按"连续 started 则 +1"自行计数。事件逐条推送，第一条到达时还不知道批次大小，实测会先闪约 30ms 的"正在搜索 <第一个 query>"。用户不接受，因此改为由后端在事件里给出批次大小。
- `labelForToolState`：running 且 count > 1 时显示 `正在搜索 N 项`，N = 1 时文案不变。`design/` 同步修改了类型和文案。
- 批次来源总数同样由后端给出：整批完成后，`ChatAgent` 按 citation id 统计全部成功调用的去重来源数（`_distinct_source_count`）。registry 对同一 URL 复用同一个 id，所以两次搜索返回的重复来源只计一次，与前端 `draftSources` 的数量一致。统计结果写入该批每个 `ToolCallFinished.batch_source_count`，被拒绝的调用也会带上。只有批次大于 1 时才写，单次调用为 `None`，payload 不变。
- 前端 `toolStateFromEvent` 和 `get_run_state` 都把它映射为 toolState 的 `batch_source_count`。`labelForToolState` 的 succeeded 分支优先使用它，其次是 `result_count`，最后是 `sources.length`。这样一批 2 次调用各返回 5 个来源时，显示的是“已找到 10 个来源”，不会先显示某一次调用的数量再跳变。
- 部分失败：只要 `batch_source_count > 0`，无论当前（最后一个）Finished 是成功还是失败，header 都显示“已找到 N 个来源”。只有整批一个来源都没拿到时，才显示失败文案。因此 header 只取决于整批结果，与调用顺序无关。有推理摘要预览的模型（如 Gemini）在调用结束后不显示这些文案。

## 系统提示词：调用上限与并行检索

`build_system_prompt`（`app/services/agents/prompts.py`）在开启 web_search 时，会在用法说明和引用规则之间插入一段：
- 注明本次回复最多可调用 `WEB_SEARCH_MAX_TOOL_CALLS` 次（线上为 10）。这个上限按 run 累计计算，超出的调用会被拒绝并返回 `tool_call_limit` 错误，所以模型需要事先知道。
- 上限大于 1 时，附加并行检索的引导：
  - 问题有互相独立的部分时，同一轮每部分各发一个查询；
  - 每个实体单独一个查询；
  - 只有依赖前面结果时才按顺序搜；
  - 前面的结果列出多个待查项时，下一轮一起搜；
  - 不要为同一问题发近似重复的查询。
- 上限说明后紧跟一句“上限是封顶而不是目标”：结果足够回答就停止搜索，不要为了核对再搜，也不要把已返回相关结果的查询换个说法重搜。第一轮 eval 之后，删掉了原来的“保留补搜余量”，并加上了这一句。

本地试跑（Gemini-3.8-Flash，本地上限为 32，每题只跑 1 次，结论不稳定）：
- 多对象对比题会在同一轮并行发 3 个查询。
- “比特币和以太坊价格”仍然合成一个查询，之后串行补搜。
- “Python 3.14 新特性”仍然一轮一个查询地串行深挖（6 次调用，61s）。
- 其中一次对比题补搜了 5 轮、共 12 次调用。该 run 的工具耗时只有 9s，总耗时 40s，大部分时间花在各轮模型调用上。

因此效率主要取决于模型调用的轮数，而不是单次工具耗时。

A/B eval（2026-09-28）：
- 设置：在 worker 容器内直接构造 `ChatAgent`，模型为 Gemini-3.8-Flash（reasoning high），上限 10。10 道题分 5 类，旧提示词（不含上限段落）和新提示词各跑 3 次，共 60 个 run，其中 8 个因 OpenRouter 连接错误失败，统计时排除。
- 并行明显增加：含并发批次的 run 占比从 16% 升到 48%，多实体题从 40% 升到 92%；多实体题首批平均查询数从 1.8 升到 2.7。
- 耗时没有改善：总体中位数从 17.3s 升到 25.3s，均值从 28.5s 升到 30.5s；多实体题均值持平（27.4s 对 27.6s），平均工具调用次数从 4.4 次增加到 5.2 次。模型并行发出首批查询后，仍会继续多轮补搜。
- 依赖链题两种提示词都会一直搜到上限（iPhone 芯片题每次 9–10 次调用），新提示词更慢。多方面题新提示词更快（均值 55.7s 降到 36.7s），但有效样本少。
- 每个 run 平均工具耗时只有约 6s，平均总耗时约 30s，耗时主要来自模型调用轮数（每轮约 7s）。
- 结论：提示词能让模型并行发查询，但减少不了补搜轮数，端到端没有变快。因此改为约束“结果足够就停止搜索”，而不是继续强调并行。

A/B eval 第二轮（2026-09-28，提示词已改为“上限是封顶，够用即停”）：
- 设置同上，模型换成直连 DeepSeek 的 `deepseek-flash`（reasoning high），每题跑 5 次，共 100 个 run，全部成功。Gemini 那轮用这版提示词跑到 29 个 run 时，因成本原因中止，数据未使用。
- DeepSeek 在基线提示词下本身就高度并行：90% 的 run 含并发批次，连单事实题首批也发 2 个查询。新提示词在总体上没有改变并行度（90% 对 90%）。
- 总体耗时略降，但在噪声范围内：中位数 11.2s 降到 10.0s，均值 13.1s 降到 12.4s；模型轮数持平（2.7），工具调用 3.6 次对 3.9 次，引用数 9.5 对 11.5。
- 收益最明显的是“最近一周 AI 新闻”：首批查询从 2 个增加到 4 个，轮数从 3–5 轮降到 2–3 轮，均值从 38s 降到 26s。“Python 3.14 新特性”反而略慢，依赖链题和多实体题基本持平。
- 结论：这版提示词对 DeepSeek 无害，对宽泛综述题有帮助，但端到端提速不显著。补搜轮数仍由模型自身的检索习惯决定，比如单事实题两种提示词下都偶尔补搜 1–2 轮。评测脚本和原始结果目前只保存在本地 scratchpad。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TOOL_CALL_MAX_CONCURRENCY` | 4 | 单个 run 同一 turn 内的工具并发上限，必须 ≥ 1，否则启动时校验失败。已写入 `.env.example`。 |
| `WEB_SEARCH_TOTAL_TIMEOUT_SECONDS` | 已有 | 已有配置，本次开始接入单次 web_search 的总超时。 |

## 验证记录（2026-09-27）

- 后端：`ruff check .` 和 `mypy app` 通过。`pytest` 结果为 834 passed、1 failed、8 errors，失败和错误都来自本地 `.env` 环境：
  - `test_capabilities_endpoint_is_public_and_hides_provider_name`：本地 `.env` 设置了 `CONVERSATION_SEARCH_ENABLED=true`。加上 `CONVERSATION_SEARCH_ENABLED=false` 后，`tests/api/test_conversations.py` 22 个全部通过。
  - `tests/services/conversations/test_search*.py`：本地搜索库密码认证失败（`InvalidPasswordError`）。
- 前端 `frontend/`：`vitest run` 771 passed，lint、typecheck、build 通过。
- `design/`：`vitest run`、lint、typecheck、`check:boundaries`、build 通过。
- Chrome 几何：按 geometry-shift 交接的方法，使用临时 fixture，通过真实 reducer 驱动完整时间线：started → reasoning → 3 个并发 running（"正在搜索 2/3 项"）→ 3 个 finished → 恢复推理 → 单次调用 → 正文。summary 和 raw 两条路径共 24 个测量点，`.thinking-label` 相对 `.thinking` 的 top 全程恒定为 4px。环境为 desktop-chromium 1440×900，临时文件已删除。

### 真实端到端（2026-09-27，本地 docker 栈，已重建 api + worker 镜像，模型为 Gemini-3.8-Flash，搜索走 Tavily）

- **API 路径**：prompt 要求模型在同一轮并行发起 4 个 web_search。
  - `run_events`：seq 4–7 是 4 个 `tool_call_started`，seq 8–11 是 4 个 `tool_call_succeeded`，均按调用顺序。
  - `runs.timing`：`phases.tool` = 2227ms，`tools[].ms` = 2202 / 1699 / 1553 / 1876（合计 7330ms），即 `phases.tool` ≈ 最慢一次。`sum(phases)` = `execution_ms` = 19793。
  - 轮询 `/state`：批次期间返回 `running_count: 4`。
  - citation id 按完成顺序分配（最先完成的 Svelte 为 1，最慢的 React 为 30），符合 Q1。
- **浏览器路径**（本地前端，使用专用测试账号）：
  - 实时流：header 依次显示"正在思考" → 摘要标题 → "正在搜索 4 项"。
  - 刷新：在"正在搜索 N 项"期间刷新页面，266ms 后恢复为"正在搜索 4 项"。
  - 下一轮单次搜索：文案回到"正在搜索 <query>"。
  - 全程 `.thinking-label` 相对 `.thinking` 的 top 恒定为 4px。该 run 共两批工具调用：`phases.tool` = 3742ms，约等于两批最慢一次之和（1962 + 1738）；`sum(phases)` = `execution_ms`。worker 无 ERROR 日志。
- **batch_size 修订后复验**（重建镜像后执行）：
  - 4 个 started 事件的 payload 均带 `batch_size=4`。`phases.tool` = 2739ms，`tools[].ms` 最大为 2701。
  - 用 MutationObserver 记录每次 DOM 变更，label 序列为"正在思考" → 摘要标题 → "正在搜索 4 项"，中间没有出现单个 query 的文案。
  - 另跑一次 3 个调用的批次：以 10ms 间隔轮询，首次出现的"正在搜索"文案就是"正在搜索 3 项"；刷新后 251ms 恢复为"正在搜索 3 项"。
  - 全程 top 恒定为 4px。
- **batch_source_count 复验**（重建镜像后通过 API 执行）：3 个并发 web_search 分别返回 10、10、8 个来源。seq 6–8 的 3 个 succeeded payload 均带 `batch_source_count=28`，与 DB 中三者来源 id 的去重数一致。批次期间 `/state` 返回 `running_count: 3`，完成后返回 `result_count: 8, batch_source_count: 28`。该改动只改文案，不改 DOM 结构和 class，没有重复测量几何。

## 待办

- 上线后关注 Tavily 限流错误率。如有需要，下调 `TOOL_CALL_MAX_CONCURRENCY`。

## 相关文件速查

- `app/services/agents/chat_agent.py`：批次准入、并发执行、事件顺序
- `app/agent/events.py`：`ToolCallFinished.elapsed_ms`
- `app/worker/timing.py`：批次墙钟时间 / 每次调用耗时
- `app/agent/tools/web_search.py`：总超时
- `app/search/postprocess.py`：同一 URL 用抽取正文替换摘要
- `app/search/tavily.py`、`app/search/registry.py`、`app/worker/main.py`：连接池与关闭
- `app/services/runs/service.py`、`app/schemas/runs.py`：`running_count`
- `app/worker/executor.py`、`app/worker/event_sink.py`：`batch_size` / `batch_source_count` 写入 payload
- `frontend/src/runs/useRunStream.ts`、`frontend/src/messages/StreamingMessage.tsx`（以及 `design/` 对应文件）：批次大小映射与文案
