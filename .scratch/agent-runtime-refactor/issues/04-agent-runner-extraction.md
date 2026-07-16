Type: refactor
Status: ready-for-agent
Blocked by: 02, 03

# AgentRunner 抽取与 worker 薄适配器化

## 目标

把 agent 编排循环从 worker executor 抽取为纯运行时 `AgentRunner`，worker 退化为
薄适配器。交付一（与 02、03 同一 PR/分支序列）的收官 ticket，行为与对外契约不变。

## 范围

1. **`AgentRunner`**：`run(config: RunConfig, sink: EventSink,
   cancel: CancellationToken) -> RunResult`。只依赖 Provider/ToolRegistry/EventSink/
   CancellationToken；发射语义事件与 delta（内存态 `RunEvent(seq, type, payload)`，
   seq 由运行时内存单调计数，Q4）；完全不碰 DB（Q10）。
2. **转写落库时机变更**：转写作为 `RunResult.transcript` 由适配器在结束时一次性落库
   （中间 turn 转写无读者，行为无损——这是交付一唯一允许的行为变化，PR 中说明）。
3. **取消统一**：`CancellationToken` 由 worker 的 heartbeat 循环驱动（发现
   cancelling / 行被抢占即 set）；运行时内部三处散装状态检查全部收编为对 token 的检查。
4. **worker 适配器**：claim → 组装 RunConfig（context/prompts 构建）→ 提供
   `PostgresEventSink`（本阶段仍写全量事件到 run_events，保持现有传输行为）→
   调用 AgentRunner → 终态状态机转换 + 转写落库 + materialize。租约/心跳/恢复不变。
   批窗口机制暂保留在 PostgresEventSink 内（06 才删除）。
5. 标题生成的内联调用点保持现状（05 处理）。

## 验收

- 存量测试不改断言通过（转写落库时机相关的测试若有，按第 2 点单独说明）。
- 新增 `AgentRunner` 纯内存测试套（FakeProvider + FakeSink + FakeToolRegistry）：
  多轮工具循环、取消时机（首 delta 前/流中/工具执行中）、provider 异常、工具异常、
  工具调用限额触顶。零 DB、零网络。
- dev 环境手工验证：正常对话、web search 对话、流中取消，SSE 行为与重构前一致。

## Comments
