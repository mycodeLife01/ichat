Type: refactor
Status: ready-for-agent
Blocked by: 04

# Agent 运行时再分层：kernel 收敛为 building blocks，编排层独立，worker 纯工程化

## 目标

修正 issue 04 交付后的分层偏差：`app/agent` 内含大量工程与业务代码（push 式
sink、seq 分配、重试规则、取消控制、run 词汇）。目标形态（对照 LangChain 四层
langchain-core / harness / runtime / Agent Server）：

| 层 | 位置 | 职责 |
|---|---|---|
| Kernel | `app/agent` | 只有 building blocks：blocks/Message 词汇、Provider 协议+适配器、Tool 协议+Registry、`stream_model_call` / `execute_tool` 原语、AgentEvent 事件词汇 |
| 编排层 | `app/services/agents`（新） | agent 循环的主人：prompt/context/工具装配 + 循环执行；未来 middleware/HITL 的着陆点 |
| Worker | `app/worker` | 纯工程：消费事件流→seq→RunEvent→sink、按 policy 执行重试、取消、终态、落库 |
| 平台 | API + `services/runs` | 不变 |

**第一原则：生成器即边界**——编排层 yield 宣告事件，worker 拉取并工程化。任何
「编排层似乎需要传输层」的场景，先检查是否只需多 yield 一种事件类型。

对外 SSE 契约、DB schema、run 状态机行为**逐字节不变**。

## 范围

### 1. Kernel 收敛（`app/agent`）

- 删除 `AgentRunner`、`RunConfig`、`RunResult`、`CancellationToken`；`events.py`
  迁出（见第 4 条）。
- 新增单次调用原语 `stream_model_call(provider, *, model, messages, reasoning,
  tools) -> AsyncIterator[TextDelta | ReasoningDelta | ModelCallResult]`：
  - delta 实时向上 yield；`ToolCallDone` 只收集不转发，流结束组装为 assistant
    `Message` 随 `ModelCallResult(message, usage, provider_request_id)` 一次性交付；
  - 命名裁决：kernel 内 turn 词根全部改为 model call（`_Turn`→`ModelCallResult`
    等）；`context.py` 的 `Turn`（对话轮）是正统用法，随迁移保留原名。
- 新增工具执行原语 `execute_tool(tool, arguments) -> ToolResult`：机械执行，
  异常包成 error result，不含限额/未知工具语义（那是编排层的）。
- AgentEvent 词汇定义在 kernel（中立词汇表的一部分，worker 依赖 kernel 而非编排
  层内部定义）：`TextDelta | ReasoningDelta | ToolCallStarted |
  ToolCallFinished(is_error) | MessageDone(message) | AgentFinal(usage,
  provider_request_id)`。succeeded/failed 判定不在事件里，归 worker 映射表。
- **取消零词汇**：kernel 无任何取消类型与检查点，只需取消安全（try/finally 清理
  provider 流与工具任务，不吞 `CancelledError`）。对齐 LangGraph「库只保证对
  task cancellation 行为良好，cancel 语义在平台层」。
- `prompts.py`、`context.py` 迁入编排层；`registry.py`（`resolve_provider`）迁入
  编排层；`DeepSeekProvider` 构造参数从整包 `Settings` 收窄为显式窄参
  （`api_key/base_url/timeout/...`，Settings→窄参展开发生在编排层 registry）。
- 收紧后的边界铁律：**`app/agent` 不 import `app.core.config`、DB/ORM、
  `app/services`**；kernel 词汇表中无 run、无 seq、无 sink、无取消。

### 2. 编排层（`app/services/agents`，新包）

- `build_chat_agent(settings, history, options) -> ChatAgent`：选 provider/model/
  reasoning、拼 system prompt、按预算裁剪 context、装配工具、定 `max_tool_calls`
  与 `RetryPolicy`。
- `ChatAgent.stream() -> AsyncIterator[AgentEvent]`：**agent 循环在这里**——
  `stream_model_call` → `MessageDone` → 检查 `ToolCallBlock` → 工具分发（未知工
  具/限额触顶产出 error `ToolResultBlock` 喂回模型，不宣告 started；正常执行则
  yield `ToolCallStarted`/`ToolCallFinished`）→ 同轮多个工具结果合为一条 user 消
  息 yield `MessageDone` → 下一次 model call；无工具调用时 yield `AgentFinal` 结
  束。
  - **可重入契约**：可变状态（计数器、当轮缓冲）全部局部化于生成器函数；实例只
    持不可变装配结果。每次 `stream()` 返回全新独立循环。
  - usage 口径不变：`AgentFinal` 取最后一次 model call 的 usage（多 model call
    run 的 usage 少计为既有已知限制，记独立小 issue，不在本票修）。
- `ChatAgent` 附带三个工程接口字段：
  - `retry_policy: RetryPolicy(max_attempts, retryable_codes)`——声明式重试策略
    （数据），按 `ProviderError.code` 分类可重试性；worker 只是执行者；
  - `tool_backend_names: dict[str, str]`——sink 外部 payload 的展示映射（原
    `tool_provider_names` 正名；SSE wire 上的 `"provider"` 字段名已冻结不动）；
  - `assistant_metadata: Callable[[], dict | None]`——materialize 收尾钩子；
    `SourceRegistry` 以闭包内化于编排层，sources/web_search/tavily 词汇不出包。
- 编排层与取消无关（同 LangChain 应用代码对取消无感），仅需取消安全。
- 组织形态保持「手写 middleware 栈」：裁剪、限额等各自独立成函数由构建函数组
  合；不建 middleware 框架（YAGNI，为将来抽 `wrap_model_call` 式钩子留平滑路径）。

### 3. Worker 纯工程化（`app/worker`）

- 消费循环：`build_chat_agent(...)` → `async for event in agent.stream()` →
  seq 自增 → AgentEvent→RunEvent 映射（`ToolCallFinished.is_error` 映射
  `tool_call_succeeded/failed`）→ `sink.emit`；`MessageDone` 同时累积 transcript。
- **重试 = 整体重启生成器**：守卫条件「尚未向 sink 转发任何事件」，满足时按
  `retry_policy` 对同一 `ChatAgent` 实例再调 `stream()`。等价性论证：现行规则本
  就只允许零输出、零 transcript 时重试，此时循环尚未走出第一步，重启整个循环 ≡
  重试首次 model call。`max_provider_attempts` 不再进入 kernel。
- **取消 = select 循环**：`gen.__anext__()` 包成子任务与取消 `asyncio.Event` 竞
  争（`CancellationToken` 删除，heartbeat 驱动裸 Event）；取消时只 cancel
  `__anext__` 子任务（`CancelledError` 精确传播进 provider/工具 await 点）→
  `gen.aclose()` → **照常 `sink.flush()`**（保留「取消时落掉已缓冲 delta」的现行
  为）→ `mark_run_cancelled`，已累积完整消息照常落库。sink 写入永不被打断。
- 终态收尾：成功时 materialize 的 metadata 改调 `spec.assistant_metadata()` 钩子
  （worker 删除 `SourceRegistry` import 与 `{"sources": ...}` 拼装）；transcript
  落库、状态机转换不变。
- `title.py` 仅做机械适配（`resolve_provider` import 换到编排层、协议签名跟随）；
  其业务组装（prompt/模型选择/清洗）暂留 worker，**迁编排层作为 issue 05 的验收
  条款**（已知妥协，如实记录）。

### 4. `events.py` 拆迁

- `RunEventType` + `RunEvent` → `app/services/runs/events.py`（run 状态机与
  `run_events` 表的规范词汇，`services/runs` 已是主要消费者）。
- `EventSink` 协议 → `app/worker`（唯一实现者与消费者；06 的 `RedisStreamSink`/
  `FanoutSink` 亦将实现它）。
- `schemas/runs.py` 的重复 `RunEventType` 保持现状不合并（API 契约与内部词汇分
  离，演进节奏不同）。
- `app/agent/__init__.py` 导出表清理。

### 5. 明确不做（演进路径记录）

- 图引擎 / State-as-dict + reducer / checkpoint-resume / interrupt。
- HITL：着陆点为编排层循环 + worker 注入手段，两条路（双向生成器 `asend` /
  interrupt+checkpoint）均不破坏本次层边界，需求出现时再选。
- `RunControl` 式软停止（无 checkpoint-resume 语义，取消即终态）。
- middleware 框架。

## 验收

- 行为逐字节等价：SSE 外部 payload、DB schema、usage 口径、取消时 flush 行为均
  不变；issue 03/04 的端到端验证脚本（普通对话、web search、流中取消、
  `after_seq` 回放、幂等取消）原样复用作判据。
- kernel 纯度可断言：`tests/agent` 新增 import 边界测试（`app/agent` 不 import
  `app.core.config`/ORM/services）。
- 编排层测试：`ChatAgent.stream()` 纯内存测试套（FakeProvider + FakeTool）覆盖
  多轮工具循环、限额、未知工具、工具异常、`stream()` 重入。
- worker 测试：seq/映射/重试守卫/取消 select 循环/终态钩子调用。
- `pytest` / `ruff` / `mypy` 全绿；`docs/architecture/module-boundaries.md` 与
  CONTEXT.md 同步修订（后者已完成）。

## 排期

- 在 issue 06 之前实施（06 的 Redis sink 会固化 runner↔sink 接口，先 06 后 04b
  是两次返工）；06 的 Blocked by 改挂 04b，其设计文档采用 `exit/async/sync`
  durability 三档词汇。
- issue 05 正交，先后皆可；05 新增验收条款：标题生成的 LLM 组装迁入编排层
  （标题 agent 构建函数），Celery task 只做触发与 DB 读写。

## Comments

- 2026-07-20：由 issue 03/04 交付评审引出，经 grilling 逐项裁决（MessageDone 命
  名、重试重启等价性、select 取消、AgentSpec→ChatAgent 修正、循环归编排层、
  provider 解析迁移、events 拆迁、title 暂留、usage 口径）后定稿。
