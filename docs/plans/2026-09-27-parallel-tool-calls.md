# 同一 turn 内工具调用并发执行计划

日期：2026-09-27

状态：已实施（2026-09-27，分支 `feat/parallel-tool-calls`；验证记录与待办见 [交接文档](../handover/2026-09-27-parallel-tool-calls.md)，真实端到端已通过）

需求依据：模型在同一个 assistant turn 中发出多个 `web_search` 调用时，现在逐个串行执行，工具阶段耗时等于各次延迟之和。改为并发执行后，工具阶段耗时约等于这一批里最慢的一次。

架构依据：`docs/architecture/overview.md`、`docs/architecture/module-boundaries.md`（`app/agent` 内核 / `app/services/agents` 编排层 / `app/worker` 的边界）、[Run 耗时规格](../specs/2026-09-27-run-timing.md)、`AGENTS.md` 的 Streaming surfaces 规则。

## 0. 现状与证据

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 执行方式 | `for call in tool_calls:` 逐个 `await execute_tool(...)` | `app/services/agents/chat_agent.py:182-206` |
| 上游是否允许一轮多调用 | 允许。各 adapter 都没有发 `parallel_tool_calls` / `disable_parallel_tool_use`；流式解析按 `index` 收齐全部调用 | `app/agent/providers/openai_compat.py:218-277` |
| 线上实际情况 | 本地库 79 个工具 turn 中 50 个一轮调用 ≥2 次；139 次调用中 110 次（79%）落在多调用 turn | 只读 SQL 统计 |
| 单次 Tavily 延迟 | 18 次真实调用：p50 2.2s，p90 3.75s，max 6.5s | `runs.timing.tools` |
| 事件 seq / DB | `ChatAgent` 不碰 DB；seq 由 worker `_consume_agent` 按 generator yield 顺序串行分配 | `app/worker/executor.py:311-318` |
| 引用编号 | `SourceRegistry.register` 是同步函数，按调用完成顺序分配 id | `app/search/postprocess.py:78-113` |
| 计时 | `RunTimer` 用 Started/Finished 配对计单次工具耗时，只有一个 `_tool_started_ms` 槽位 | `app/worker/timing.py:96-107` |
| 前端 | 只有一个 `toolState`，始终显示最新一个工具事件 | `frontend/src/runs/state.ts:115-129` |

Eval（真实 worker → ChatAgent → WebSearchTool 链路，只打桩 LLM / Tavily / sink，5 次重复）结果：一轮 3 次调用端到端 p50 从 11.8s 降到 8.0s，5 次从 15.4s 降到 7.5s；单调用 turn 无变化；超时 / 500 / 超限 / 取消场景行为与串行一致。harness 与原始数据留在本次会话 scratchpad，不入库。

## 1. 已定决策

- D1：并发只发生在**同一个 assistant turn 内**。多个 turn 之间仍然串行（下一次模型调用需要本轮全部结果）。
- D2：**事件仍然只从 `ChatAgent.stream()` 这个 generator 里 yield**。子任务不直接产出事件，也不接触 sink / seq / DB，worker 无需任何改动即可保持 seq 连续。
- D3：事件顺序改为：按调用顺序先 yield 所有 `ToolCallStarted`，并发执行，全部完成后再**按调用顺序** yield 所有 `ToolCallFinished`。不按完成顺序边完成边发，避免前端在其它调用还在跑时就显示"成功"。
- D4：工具结果 `ToolResultBlock` 按模型给出的调用顺序拼接，与现在一致。
- D5：预算判定（未知工具 → `unknown_tool`，超出 `max_tool_calls` → `tool_call_limit`）在并发前按调用顺序一次性完成，语义与现在完全相同：哪些调用会被执行、哪些被拒，只取决于顺序，与完成时间无关。
- D6：新增并发上限配置 `tool_call_max_concurrency`（默认 4），在 `ChatAgent.stream()` 内部用本地 `asyncio.Semaphore` 控制。避免多个 Run 同时进行时，Tavily 瞬时并发达到 `WORKER_MAX_INFLIGHT_RUNS × N`。`WEB_SEARCH_MAX_TOOL_CALLS` 保持线上 ENV 现状，不改。
- D7：单次工具耗时由 `ChatAgent` 测量，通过 `ToolCallFinished` 新增字段 `elapsed_ms` 传给 `RunTimer`。该字段不进入 `metadata`，因此不会出现在 run event payload / SSE 里。
- D8：用 `asyncio.gather`。`execute_tool` 已把所有 `Exception` 转成错误结果，gather 不会因单个失败提前中断；外层取消时 `CancelledError` 会传播并取消所有子任务（eval 已验证无泄漏）。

## 2. 交付目标与成功标准

| 编号 | 成功标准 | 证明手段 |
| --- | --- | --- |
| S1 | 同一 turn 的 N 个调用并发执行，墙钟时间约等于最慢一次，而非总和 | `test_chat_agent.py` 新增用 sleep 工具的计时测试 |
| S2 | 事件序为 Started×N → Finished×N（均按调用顺序）；`ToolResultBlock` 顺序与调用顺序一致 | 更新 `test_multi_tool_turn_yields_events_and_messages` |
| S3 | unknown / 超限调用的结果、错误码与现在一致，且不占用并发槽位 | 现有 limit / unknown 测试 + 新增混合场景测试 |
| S4 | 并发数不超过 `tool_call_max_concurrency` | 新增测试：记录同时在飞数的最大值 |
| S5 | 单个调用失败或超时，不影响同批其它调用返回结果 | 新增混合失败测试 |
| S6 | 取消时所有在飞工具任务被取消，generator 正常收尾 | 新增取消测试 |
| S7 | `runs.timing.tools[].ms` 是每次调用的真实耗时；`phases.tool` 等于并发批次的墙钟时间；`sum(phases) == execution_ms` 不变 | `tests/worker/test_timing.py` 更新 + 新增并发批次测试 |
| S8 | worker seq 连续；run 事件 payload 只新增并发批次的 `tool_call_started.batch_size` 和 `tool_call_succeeded/failed.batch_source_count`，其余不变 | 现有 `tests/worker/test_executor.py` 全部通过 |
| S9 | 一轮多调用时 header 显示 `正在搜索 N 项`，N = 1 时文案不变；断线重连后文案一致；header 行几何不变 | `state.test.ts` + 后端 run state 测试 + Chrome 几何测量 |
| S10 | 单次 web_search 超过 `web_search_total_timeout_seconds` 时返回 `timeout` 错误结果，不登记来源；外层取消仍然传播 | `tests/agent/test_tools.py` 新增用例 |
| S11 | 同一 worker 进程内的多次 Tavily 请求复用同一个连接池；worker 退出时关闭该连接池；注入 transport 的测试行为不变 | `tests/search/test_tavily.py` 新增用例 |

## 3. 改动清单

### 3.1 `app/agent/events.py`

`ToolCallFinished` 新增 `elapsed_ms: int | None = None`。未真正执行的调用（unknown / 超限）为 `None`。

### 3.2 `app/services/agents/chat_agent.py`

`ChatAgent.__init__` 新增 `max_tool_concurrency: int` 参数，并由 `build_chat_agent` 从 `settings.tool_call_max_concurrency` 传入。`stream()` 中第 181-206 行的循环替换为三段：

1. **分类（按调用顺序）**：对每个 call，确定是 unknown / 超限 / 待执行；待执行的 `tool_calls_used += 1`。
2. **Started**：对待执行的调用按顺序 `yield ToolCallStarted(...)`。
3. **并发执行**：`asyncio.gather` 执行每个待执行调用，每个调用用 `async with semaphore` 包住 `execute_tool`，用 `time.monotonic()` 测量耗时。
4. **Finished + 结果**：按原调用顺序，对**每一个** call（包括 unknown / 超限）`yield ToolCallFinished(..., elapsed_ms=...)`，并追加对应的 `ToolResultBlock`。

注意：现在 unknown / 超限调用的 Finished 与已执行调用的 Started/Finished 是交错发出的；改后它们统一在 Finished 段按调用顺序发出。前端对这类没有 Started 的 Finished 只更新 `toolState`，不受影响。

模块 docstring 中"generator is the boundary"的描述不变；在循环处加一行注释说明为何 Finished 要等全部完成后按序发出（D3）。

### 3.3 `app/core/config.py`

新增 `tool_call_max_concurrency: int = 4`（校验 ≥1）。同步 `.env.example` 的 web search 配置段。`docs/deployment.md` 的 env 示例只列出必填项，不含超时 / 额度类配置，因此不改。

### 3.4 `app/worker/timing.py`

- `ToolCallStarted`：切到 `tool` 阶段（行为不变；连续多个 Started 不会重复切换）。
- `ToolCallFinished`：切回 `model_wait`（行为不变：首个 Finished 就结束 tool 阶段，后续 Finished 连续到达，间隔约 0，因此 `phases.tool` = 并发批次墙钟时间）。
- `tools[].ms` 改为取 `event.elapsed_ms`，为 `None` 时记 0；删除 `_tool_started_ms` 配对逻辑。

### 3.5 文档

- `docs/specs/2026-09-27-run-timing.md` §3.2 的 `tool` 行：由"按顺序执行，无并行重叠"改为"同一 turn 内并发执行；`phases.tool` 记并发批次的墙钟时间，`tools[].ms` 记每次调用自身耗时，因此 `sum(tools[].ms)` 可以大于 `phases.tool`"。
- 实施完成后新增 `docs/handover/2026-09-27-parallel-tool-calls.md`，并在 `docs/README.md` 加一行索引。

### 3.6 web_search 总超时（使用 `web_search_total_timeout_seconds`）

现状：该配置（默认 25s）只定义、未使用。httpx 的超时是**单次操作**超时（connect / 每次 read），不是整个请求的总时长；一次 `web_search` 可能串联 direct extract（8s）+ search（12s）+ extract（8s），外加各自的 connect，而且服务端慢速返回数据时，read 超时会不断重置。串行时这只拖慢单个调用；并发后整批要等最慢的那个，一个挂住的调用会卡住整轮，所以总时长上限变得必要。

改动：

- `WebSearchConfig` 新增 `total_timeout_seconds`，由 `_web_search_config(settings)` 从 `web_search_total_timeout_seconds` 填入。
- `WebSearchTool.execute` 用 `asyncio.timeout(config.total_timeout_seconds)` 包住 `run_web_search`，超时后返回错误结果 `timeout`，文案与现有 Tavily timeout 一致（"Web search timed out. Continuing without live results."）。
- `SourceRegistry.register` 在所有网络请求之后才调用，超时取消发生在登记之前，不会留下半登记的来源。
- 外层取消（Run 被取消）仍然抛出 `CancelledError`，不会被转换成错误结果。

### 3.7 Tavily 连接复用

现状：`TavilySearchClient._post_json` 每次请求都 `async with httpx.AsyncClient(...)`（`app/search/tavily.py:140`），每次调用都要重新做 TCP + TLS 握手，search 后接 extract 时也会握手两次。

改动：

- `app/search/tavily.py` 增加模块级的共享 `httpx.AsyncClient`，首次使用时惰性创建，所有 `TavilySearchClient` 实例共用（它的生命周期是进程，而不是单个 Run）。连接池上限设为 `max_connections = WORKER_MAX_INFLIGHT_RUNS × tool_call_max_concurrency`，保证池子不会成为新的排队点。
- 超时改为按请求传入：`client.post(path, ..., timeout=httpx.Timeout(timeout_seconds, connect=5.0))`；`base_url` 与 `Authorization` 头仍按请求设置，不把密钥固化进共享 client。
- 构造时传入 `transport` 的实例（测试用）继续使用自己独立的 client，现有 `tests/search/test_tavily.py` 不受影响。
- 新增 `aclose_shared_search_clients()`，在 worker 主循环的 `finally` 中（`app/worker/main.py`，drain inflight runs 之后）调用。
- API 进程不执行搜索，不创建这个 client。

收益：每次调用省一次握手，量级为几十到几百毫秒，取决于部署机房到 Tavily 的网络，eval 未单独测量。并发批次中各调用的握手是重叠的，所以对端到端的改善小于 N × 握手时间。

### 3.8 前端"正在搜索 N 项"

现状：`labelForToolState`（`frontend/src/messages/StreamingMessage.tsx:93-101`）只看最新一个工具事件，运行中显示 `正在搜索 {query}`。

批次大小（2026-09-27 修订）：`ToolCallStarted` 携带 `batch_size`（本轮准入调用数，被拒绝的 unknown / 超限调用不计入）。worker 把它写入 `tool_call_started` payload，只有 > 1 时才写，单次调用的 payload 不变。前端和 `get_run_state` 都直接读取这个值。

最初方案是由前后端按"连续 started 则 +1"自行计数。端到端验证发现，第一个 started 到达时前端还不知道批次大小，会先闪约 30ms 的"正在搜索 <第一个 query>"，所以改为由后端在事件里直接给出批次大小。

改动：

- 后端 `RunToolStateResponse` 新增 `running_count: int = 1`，由 `_tool_state_from_event` 在 running 状态下取 payload 的 `batch_size`，让断线重连后恢复出的 header 与实时流一致。
- 前端 `RunToolState` 类型新增 `running_count`；`useRunStream.ts` 的 `toolStateFromEvent` 把 started 事件的 `batch_size` 映射为 `running_count`；`run/restored` 直接使用后端值。
- 文案：
  - 运行中 N = 1：`正在搜索 {query}`（不变）。
  - 运行中 N > 1：`正在搜索 N 项`。
  - 完成后仍显示最后一个事件的结果（`已找到 X 个来源` / 失败文案）。并发批次中，X 取整批按 citation id 去重后的来源总数，见下文。
- 批次来源总数（2026-09-27 追加）：`ToolCallFinished` 新增 `batch_source_count`。整批完成后，由 `ChatAgent` 按 citation id 统计成功调用的去重来源数，写入该批每个 Finished 事件，只在批次大于 1 时写入。worker 把它写入 `tool_call_succeeded/failed` payload，前端和 `get_run_state` 都映射为 toolState 的 `batch_source_count`。“已找到 X 个来源”优先使用它，避免显示单次调用的数量，也避免 Finished 连续到达时数字跳变。只要它大于 0，即使最后一个 Finished 是失败事件，header 也显示总数；整批没有来源时才显示失败文案。
- design workbench 的镜像 `design/src/messages/StreamingMessage.tsx` 同步修改。
- 只改变 label 文字，不新增或切换任何 class，header 行几何不变；仍按 AGENTS.md 要求用真实 Chrome 测量（第 6 节第 4 步）。

改动量：后端约 20 行加测试；前端 reducer、类型、label 共约 30 行，外加 `state.test.ts` 用例和 design 镜像。

## 4. 不做的事（本期范围外）

- **引用编号按调用顺序分配**：已确认接受按完成顺序分配（Q1）。
- **完成后的汇总文案**（例如"已完成 3 项搜索，共找到 12 个来源"）：本期不做，完成后沿用最后一个事件的文案。

## 5. 前端影响

- 事件变为 Started×N → Finished×N：运行中按 3.8 显示 `正在搜索 N 项`（N = 1 时保持原文案），全部完成后显示最后一个调用的结果文案。
- `draftSources` 在每个 `succeeded` 事件上合并，不受顺序影响。
- 断线重连 `run/restored` 使用后端 `tool_state.running_count`，与实时流一致。
- header 只有文字变化，不改变任何 class / 几何。

## 6. 验证

后端（在仓库根目录）：

```bash
uv run pytest tests/services/agents/test_chat_agent.py tests/worker/test_timing.py tests/worker/test_executor.py tests/search tests/agent
uv run pytest
uv run ruff check .
uv run mypy app
```

端到端：

1. 本地启动 API + worker + 前端，开启 web search，发一个会触发多次搜索的问题（例如"对比 A、B、C 三个框架的最新版本"）。
2. 查 `runs.timing`：`phases.tool` 约等于 `max(tools[].ms)`，而不是总和；`sum(phases) == execution_ms`。
3. 查 `run_events`：seq 连续，Started×N 后接 Finished×N。
4. 按 `docs/handover/2026-08-31-thinking-header-geometry-shift.md` 的方法，在 Chrome 中测量 thinking header 在工具阶段前后的几何，确认无位移。
5. 断线重连：在"正在搜索 N 项"期间刷新页面，恢复后文案一致。

前端（在 `frontend/`、`design/` 下分别运行）：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

6. 可选：重跑 scratchpad 的 eval harness，确认改动后的真实代码与 harness 中并发版本的结果一致。

## 7. 已确认（2026-09-27 review）

- Q1：引用编号按完成顺序分配，接受，本期不处理。
- Q2：并发上限默认 4。
- Q3：配置项命名为 `tool_call_max_concurrency`。
- 追加范围：Tavily 连接复用（3.7）与前端"正在搜索 N 项"（3.8）纳入本期；总超时（3.6）同样纳入本期。
