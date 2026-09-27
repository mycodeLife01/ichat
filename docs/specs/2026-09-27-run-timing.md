# Run 耗时记录与工作时长展示（Run timing）

- 日期：2026-09-27
- 状态：已确认（2026-09-27 review），已实现（分支 `feat/run-timing`）
- 范围：worker 执行链路（`app/worker/executor.py`）、`runs` 表、会话详情 API（`MessageResponse`）、
  live 对话页思考 header（`frontend/src/messages/ThinkingBlock.tsx`、`Message.tsx`）及 design
  workbench 对应镜像
- 不涉及：公开分享页（明确不展示）、SSE 事件词汇、Run Stream / 草稿检查点、计费与限流

## 1. 背景与目标

目前 Run 只有粗粒度时间戳：`created_at`、`started_at`（worker 认领）、`first_streamed_at`
（首次进入 streaming）、`completed_at`（进入终态）。这些时间戳无法回答「这次回复的时间花在了
哪里」：推理、工具调用和正文生成在一个 Run 内交替进行（一个 Run 可含多次模型调用），而
`text_delta` / `reasoning_delta` 只进 Redis Run Stream，不落 PG，事后无法从 `run_events` 还原。

目标：

1. **记录全部维度**：worker 在执行时把 Run 的完整耗时切成互不重叠的阶段并持久化，供开发者
   观测各阶段效率。
2. **按产品策略展示**：用户侧默认只展示「工作时长」（思考 + 工具，即开始写正式答复前的耗时）。
   数据层与展示策略分离，以后调整展示维度不需要改采集。
3. **分享页不展示**：公开分享快照不含任何耗时字段。

## 2. 产品需求

| # | 场景 | 期望 |
|---|---|---|
| R1 | 成功的 Run，历史消息带思考块 | 思考 header 收起态文案由「已思考」变为「已思考 12 秒」，数值由服务端提供，刷新、重进会话后保持一致 |
| R2 | 流式进行中 | header 文案与现在一致（「正在思考」/ 小标题 / 工具状态 / 正文开始后的「已思考」），不显示实时跳秒 |
| R3 | 流式结束、刷新会话详情后 | 「已思考」原地变为「已思考 12 秒」，只改文字，header 行几何不变 |
| R4 | 历史 Run（上线前）或没有 timing 的 Run | 保持「已思考」，不显示数值，不报错 |
| R5 | 没有思考块的回复（无推理输出，含只调用了工具的回复） | 后端照常按阶段记录并下发 `work_ms`；用户侧不展示，因为展示只挂在已有思考 header 上 |
| R6 | 失败 / 取消的 Run | 服务端照常记录已发生部分；用户侧不展示 |
| R7 | 公开分享页 | 不展示，快照与分享 API 均不含 timing |
| R8 | 开发者 | 每个进入终态的 Run 都有结构化日志与 `runs.timing` 可查，阶段加总等于执行总时长 |

## 3. 术语与阶段定义

### 3.1 时间轴

```
created_at ──queued──▶ 认领(started_at) ──▶ worker 执行起点 t0 ─────────────────────▶ 终态 t_end
                                            │ preparing │ model_wait │ reasoning │ tool │ … │ answering │ finalizing │
```

- **queued**：`started_at - created_at`，由 PG 时间戳计算（API 进程与 worker 进程的墙钟）。
- **执行时长 `execution_ms`**：worker 进入 `execute_run` 的 t0 到终态落库完成的 t_end，
  用 worker 进程内单调时钟（`time.monotonic()`）测量，不受墙钟跳变影响。
- 执行区间内每一刻**恰好归属一个阶段**，因此 `sum(phases) == execution_ms`（整数毫秒，
  取整余量并入最后一个阶段，保证严格相等）。

### 3.2 阶段

| 阶段 | 计时区间 | 说明 |
|---|---|---|
| `preparing` | t0 → 首次模型调用发出 | 载入历史、来源、模型路由、构建 agent（含附件/图像上下文装配） |
| `model_wait` | 每次模型调用开始 → 该调用第一个 delta；工具结果返回 → 下一次调用首个 delta | 上游首包延迟。可重试错误导致的整次重试耗时也记入此阶段 |
| `reasoning` | 当前阶段为推理时的累计时长 | 收到 `ReasoningDelta`（raw 或 summary）后进入，直到下一个不同类别事件 |
| `answering` | 当前阶段为正文时的累计时长 | 收到 `TextDelta` 后进入。前言正文（工具调用前的正文）也计入此阶段 |
| `tool` | 一批 `ToolCallStarted` → 该批第一个 `ToolCallFinished` | 同一 turn 的工具调用并发执行（2026-09-27 起，见[并发计划](../plans/2026-09-27-parallel-tool-calls.md)），Finished 在整批完成后按调用顺序连续发出，因此 `phases.tool` 是并发批次的墙钟时间。`tools[].ms` 取事件携带的单次调用耗时（`elapsed_ms`），所以 `sum(tools[].ms)` 可以大于 `phases.tool`。没有 Started 的 Finished（未知工具、超限）计 0 |
| `finalizing` | agent 流结束 → 终态事务提交 | 物化消息、持久化 transcript、终态事件 |

阶段切换规则（worker 内状态机，按事件到达 worker 的时刻计时）：

- 模型调用边界：t0 之后第一次迭代 agent 流即视为第 1 次调用开始；每个 role 为 user 的
  `MessageDone`（工具结果消息）之后即视为下一次调用开始，进入 `model_wait`。
- 一次调用内，delta 之间的间隔归属当前阶段（上一个 delta 的类别）。
- `ToolCallStarted` 进入 `tool`，`ToolCallFinished` 回到 `model_wait`（等待下一次调用）。
- `sink.emit` 的背压时间计入当前阶段。这是可接受的近似：它同样是用户感受到的耗时。

### 3.3 派生指标

| 指标 | 定义 | 用途 |
|---|---|---|
| `work_ms` **工作时长** | t0 → **最后一次模型调用**的第一个 `TextDelta` | 用户侧默认展示。等价于「思考 + 工具 + 其间上游等待 + 准备」。最后一次调用在流结束后才能确定，因此 worker 记录每次调用的首个正文时刻，终态时取最后一次。没有最终正文（失败、取消在答复前）时为 `null` |
| `ttft_ms` | t0 → 第一个任意 delta | 开发者观测首包 |
| `model_calls` | 模型调用次数 | |
| `attempts` | `_consume_agent` 的整体重试次数 | |
| `tools` | `[{name, ms, ok}]`，按调用顺序 | 定位慢工具 |

工作时长**不含 queued**：排队反映系统积压，不是这次回复本身的工作；queued 单独记录，
供开发者观测。

不存储 tokens/s：`usage_metadata` 只含最后一次模型调用的 usage（见 `AgentFinal` 注释），
与多次调用的 `answering` 不对应，存储会产生误导。

## 4. 设计

### 4.1 数据结构

新增列 `runs.timing JSONB NULL`（Alembic 迁移，仅加可空列，无回填）。结构：

```json
{
  "version": 1,
  "outcome": "succeeded",
  "queued_ms": 42,
  "execution_ms": 15320,
  "work_ms": 12100,
  "ttft_ms": 1830,
  "phases": {
    "preparing": 210,
    "model_wait": 2950,
    "reasoning": 6400,
    "tool": 2540,
    "answering": 3020,
    "finalizing": 200
  },
  "model_calls": 2,
  "attempts": 1,
  "tools": [{"name": "web_search", "ms": 2540, "ok": true}]
}
```

- `phases` 六个 key 总是存在（未发生的阶段为 0），`sum(phases) == execution_ms`。
- `version` 用于以后调整阶段定义；读取方遇到未知版本时忽略 timing。
- `tools` 不含参数和查询内容，避免把用户输入复制进观测数据。

### 4.2 采集（worker）

- 新增一个纯内存的计时累加器（如 `app/worker/timing.py` 的 `RunTimer`），输入为「事件类别
  + 单调时钟时刻」，输出上面的 dict。它不依赖 DB、sink 或 agent，便于单测。
  - 计时属于 worker 的工程化职责（`docs/architecture/module-boundaries.md`：seq、发布、
    持久化归 worker），不放进 `app/agent` 内核或 `app/services/agents` 编排层。
- `execute_run` 在入口创建 timer；`_consume_agent` 在每个 AgentEvent 上调用 timer（包括
  不转发给 sink 的 `MessageDone`，用于识别调用边界）；重试时 timer 不重置，只把耗时记入
  `model_wait` 并 `attempts += 1`。
- 终态写入：
  - 成功 / worker 发起的失败 / 取消：在 `_finalize_result`、`_mark_failed_or_cancelled_if_cancelling`
    的同一事务内写 `runs.timing`。`finalizing` 以写入前的时刻截止，t_end 即此刻（不包含
    commit 本身的耗时，这一点是为了在同一事务写入而接受的误差）。
  - agent 构建失败（`context_build_error`）：写入只有 `preparing` 的 timing。
  - 从未被 worker 执行的 Run（queued 时直接取消）、租约过期由 `recover_expired_runs` 置为
    failed 的 Run：`timing` 为 `null`。
- 结构化日志：终态后用与 `_emit_vision_run_metric` 相同的写法打一条
  `metric="run_timing"` 日志，字段为 timing 全部内容加 `provider_name`、`provider_model`、
  `route_id`（取自 `model_config_snapshot`）与 `outcome`。这是开发者跨 Run 聚合的入口。

### 4.3 下发（API）

- `MessageResponse` 新增 `timing: MessageTimingResponse | None`，**只暴露展示策略需要的字段**：

  ```python
  class MessageTimingResponse(BaseModel):
      work_ms: int
  ```

  完整阶段数据只在 DB 与日志中，不进入用户 API。
- **采集与展示分离**：后端对所有 Run 一视同仁地按阶段记录，不因模型是否输出推理、是否调用
  工具而改变采集或下发；「只在有思考块时展示」是前端的展示规则。以后若产品要展示更多维度（例如展开明细），
  在这个模型上加字段即可，采集不变。
- 组装：`get_conversation_detail` 已通过 `_run_public_id_map` 按 message.run_id 批量查询
  runs；把它扩展为同时取 `Run.timing`，无新增查询。仅 assistant 消息、`timing.version == 1`
  且 `work_ms` 非空时返回，否则 `null`。
- 其他返回 `MessageResponse` 的接口（发送消息、编辑等）返回的都是 user 消息或尚无 timing
  的状态，字段为 `null`，无需改动。
- **分享**：`app/services/shares/service.py` 的快照按字段白名单构造，不加入 timing；分享 API
  schema 不变。需加一条测试守住「分享快照不含 timing」。
- SSE 终态事件 payload、`RunStateResponse` 不变：成功后前端本来就会重新拉会话详情
  （`useRunStream.ts`），不需要额外通道。

### 4.4 前端展示

- `api/types.ts` 的消息类型新增 `timing?: { work_ms: number } | null`。
- `Message.tsx` 把 `message.timing?.work_ms` 作为新 prop（如 `workMs`）传给 `ThinkingBlock`；
  `StreamingMessage` 不传。
- `ThinkingBlock` 非流式 header 文案：`workMs` 存在时为 `已思考 ${formatDuration(workMs)}`，
  否则保持「已思考」。显式 `label` 与流式文案优先级不变。
- `formatDuration`：
  - `< 1000ms` → 「不到 1 秒」
  - `< 60s` → 「N 秒」（四舍五入）
  - `≥ 60s` → 「M 分 N 秒」（N 为 0 时为「M 分钟」）
- 用 `已思考` 作为前缀，虽然工作时长包含工具：与 header 在收起态的现有语义一致，也是同类产品
  的惯例；工具耗时通常较短，不单独命名。
- **几何约束**（AGENTS.md Streaming surfaces）：只改 header 文字内容，不新增元素、不按
  `workMs` 切换任何 class。流式结束、刷新详情后「已思考」原地变为「已思考 12 秒」，
  `.thinking-label` 相对 `.thinking` 的 top 必须保持不变。
- Design workbench：`design/src/messages/ThinkingBlock.tsx` 同步同一文案逻辑，已有的思考类
  场景补一个带 `workMs` 的历史态，保持 parity。

## 5. 成功标准与验证

| # | 标准 | 验证 |
|---|---|---|
| S1 | 各类终态 Run 的 timing 结构正确，`sum(phases) == execution_ms` | `RunTimer` 单测：纯推理、推理→工具→推理→正文、前言正文→工具→正文（`work_ms` 取最后一次调用）、重试、取消在正文前（`work_ms=null`）、Finished 无 Started |
| S2 | worker 在成功、失败、取消、构建失败时写入 timing；租约过期为 null | `tests/worker` 下 executor 集成测试，使用现有 fake provider，注入可控时钟 |
| S3 | 会话详情返回 `timing.work_ms`，历史 Run 返回 null，且不新增查询 | `tests/api` 会话详情测试 |
| S4 | 分享快照与分享 API 不含 timing | `tests/services` 分享快照测试 |
| S5 | 「已思考 N 秒」按格式规则显示；无 timing 时回退「已思考」 | `ThinkingBlock.test.tsx`、`Message` 相关 vitest；`formatDuration` 单测 |
| S6 | header 几何不变 | 真实 Chrome 测量（方法见 `docs/handover/2026-08-31-thinking-header-geometry-shift.md`）：1440 / 390 宽度下，streaming 各 phase → 收起「已思考」→「已思考 12 秒」，`.thinking-label` top 恒定 |
| S7 | 迁移可升可降 | `alembic upgrade head` / `downgrade -1` |

CI 同款检查：后端 `pytest`、`ruff check`、`mypy`；前端 `pnpm run typecheck`、`pnpm run lint`、
`pnpm exec vitest run`、`pnpm run build`；design 按 workbench 规定跑 lint、typecheck、
test、test:parity。

## 6. 发布与回滚

- 迁移只加可空列，先迁移后发代码，旧代码忽略该列。
- 上线前的 Run 全部为 `null`，前端回退「已思考」，无需回填（回填也不可能：delta 未落 PG）。
- 回滚：还原代码即可，列可保留；如需彻底回滚执行 downgrade 删除列。

## 7. Review 决定（2026-09-27）

1. **文案**：使用「已思考 N 秒」。
2. **流式期间实时跳秒**：不做，只在终态后显示服务端数值。
3. **无思考块的回复**：用户侧不展示；后端仍按阶段完整记录（含工具耗时）并下发 `work_ms`，
   展示与否由前端规则决定。
4. **失败 / 取消**：用户侧不展示；后端照常记录已发生部分。
