# Agent 运行时重构：agent 内核抽取 + Redis Stream 流式传输 + 任务分层统一

> 本 PRD 由 2026-07-16 的架构评审与逐项拷问（14 个设计决策 + 术语裁决）汇总而成。
> Ticket 索引见文末；实施顺序与阻塞关系以各 ticket 的 `Blocked by` 为准。

## Problem Statement

作为 iChat 的维护者，我在扩展 agent 能力（新工具、新 provider、新编排行为）时必须钻进
worker 进程的实现内部修改一个千行文件；系统的实时流式输出全部压在 PostgreSQL 上
（每个 delta 批次一次行锁事务 + 每个 SSE 订阅者每次唤醒回查 PG），压测已经证实这限制了
在线并发容量；同时 LLM 与业务之间的通信记录以 DeepSeek/OpenAI 的 wire format 原样
持久化在事实源里，导致未来接入其他 provider 时数据不可复用。项目的目标是生产规格
（架构层面支持至少上千在线用户），当前实现无法达到。

## Solution

分三个独立交付完成重构：

1. **交付一（agent 内核）**：建立 `app/agent/` 内核包，以 provider 中立的 content-blocks
   消息模型统一 Message/Provider/Tool/Runtime 词汇；把 agent 编排循环从 worker 抽取为
   纯运行时 `AgentRunner`（不碰 DB、不碰传输），worker 退化为薄适配器；DeepSeek 适配器
   改用 openai SDK；转写持久化切换为中立 blocks 格式（expand-contract）。纯重构，
   行为与对外契约不变。
2. **交付二（Redis Stream 流式）**：delta 事件不再逐条落 PG，改为 provider 每吐一个
   chunk 立即 `XADD` 到 Redis Stream；SSE 端以每连接独立 `XREAD BLOCK` 订阅；PG 以
   低频 draft checkpoint + 语义事件兜底；Redis 故障时优雅降级为 checkpoint 轮询。
   SSE 对外契约逐字节冻结，前端零改动。
3. **交付三（收尾）**：标题生成迁移为 Celery 任务；后台任务约定明文化；`runs_queued`
   唤醒信号迁移 Redis（原阶段 4b）；存量 delta 行清理（执行时机由所有者决定）。

阶段 4 其余项（共享租约模块 4a、失败观测口径统一 4c）明确延后，不在本 PRD 范围内。

## User Stories

1. 作为 agent 功能开发者，我想在一个统一的 `app/agent/` 包内完成新工具的注册与接入，而不需要修改 worker 编排代码，以便快速扩展 agent 能力。
2. 作为 agent 功能开发者，我想让编排循环通过 `ToolRegistry` 分发工具调用而非硬编码工具名判断，以便新增工具时只写工具本身。
3. 作为后端维护者，我想让业务内部流转的消息模型（content blocks）与任何 provider 的 wire format 解耦，以便阅读和修改 agent 代码时不需要了解 DeepSeek 的协议细节。
4. 作为未来的 provider 接入者，我想让中立消息模型能无损映射到 Anthropic/OpenAI/Gemini 三家的消息 API，以便新增 provider 只需实现一个适配器。
5. 作为未来的 provider 接入者，我想让 provider 的怪癖（如 DeepSeek 无法回放 tool 历史）通过 capabilities 声明收编在适配器内部，以便编排层按能力决策而不是按 provider 名字分支。
6. 作为后端维护者，我想让事实源（转写表）存储 provider 中立的 blocks 格式，以便历史对话数据在更换 provider 后依然可复用。
7. 作为后端维护者，我想让存量 wire format 转写行通过读取时转换继续可用，以便格式演进不需要一次性不可逆的数据迁移。
8. 作为后端维护者，我想让 `AgentRunner` 完全不依赖数据库和传输层，以便用纯内存 fake 对编排逻辑（多轮工具循环、取消时机、异常路径）做快速、确定性的测试。
9. 作为后端维护者，我想让 DeepSeek 适配器使用 openai SDK 而非手写 HTTP/SSE 解析，以便传输层的重试、超时、连接复用和类型解析交给成熟库。
10. 作为聊天用户，我想让流式回复尽可能即时——provider 吐出内容后端立刻推送，以便获得顺畅的打字机体验（删除人为批窗口延迟）。
11. 作为聊天用户，我想在断线重连后从上次位置无缝续读（`after_seq` 语义不变），以便网络抖动不丢失正在生成的内容。
12. 作为聊天用户，我想在 Redis 故障期间对话功能依然完整可用（降级为几秒一段的粗粒度更新），以便核心功能可用性不被缓存组件绑架。
13. 作为聊天用户，我想在打开多个标签页时每个标签都能独立订阅同一条 run 的流，以便多端体验一致。
14. 作为运维者（未来的我），我想让 PG 摆脱每 delta 一次行锁事务的写放大和事件数×订阅者数的读放大，以便同规格硬件支撑更高并发。
15. 作为运维者，我想让 Redis stream 有容量上限（MAXLEN）和双重 TTL（终态短 TTL + 首写兜底 TTL），以便不产生内存泄漏类运维事故。
16. 作为运维者，我想让容量参数（MAXLEN、checkpoint 间隔等）全部可配置，以便架构按上千并发规格设计、参数按 1C2G 盒子取保守初值。
17. 作为运维者，我想让阶段性交付出问题时能靠 GHCR 镜像回滚兜底，以便不维护长期存在的双轨运行时开关。
18. 作为后端维护者，我想让标题生成这类"非流式、幂等、可重试"的任务由 Celery 执行而非内联在 run 收尾中，以便 run 尽快释放并发槽且任务获得重试能力。
19. 作为后端维护者，我想有一份明文化的后台任务约定（事务性状态行 + 唤醒信号 + 幂等 claim，及新任务归属判据），以便未来新增任务时不再逐案争论。
20. 作为前端维护者，我想让 SSE 事件格式与恢复端点契约完全冻结，以便本次后端重构不需要前端任何配合部署。
21. 作为后端维护者，我想让 `run_events` 表在交付二之后只承载语义事件、存量 delta 行被清理，以便表体积和无效读路径不再增长。
22. 作为项目所有者，我想让每个交付有可复现的验收标准（存量测试不改断言、N=200 压测对比基线、拔 Redis 降级演练），以便"完成"有客观判定。

## Implementation Decisions

### 决策记录（拷问确认，编号对应评审记录）

| # | 决策点 | 结论 |
|---|--------|------|
| Q1 | 交付节奏 | 阶段 1+2 一次交付；阶段 3 独立交付；阶段 4 延后（后修订：4b 唤醒迁 Redis 收编为 ticket 08，4a/4c 维持延后） |
| Q2 | 消息模型 role | 三 role（system/user/assistant），工具结果为 user 消息内 `ToolResultBlock`（Anthropic 式）；blocks→扁平是无损投影，中立模型站在信息更丰富的一端 |
| Q3 | 转写持久化 | expand-contract：转写表新增 `blocks` JSONB 列，新行只写 blocks（旧列置 NULL），旧行读取时转换（转换逻辑归 DeepSeek 适配器）；1 条消息 = 1 行（多工具结果在同一行的 blocks 数组内） |
| Q4 | 事件游标 | 自管整数 seq：worker（每 run 唯一写者，租约保证）内存单调计数；Redis entry field 与 PG 语义事件均携带 seq，两个世界共用一个坐标系；worker 崩溃即 run failed，不做断点续跑 |
| Q5 | Redis 故障 | 优雅降级：XADD 失败丢弃该 delta 仅记警告（checkpoint 与语义事件照写 PG）；SSE 端退回 checkpoint 轮询；熔断器不做 |
| Q6 | checkpoint | 独立表 `run_drafts`（每 run 一行，upsert 覆盖，终态后可删）；触发：3 秒时间窗为主参数 / 4KB 字符量为防御上限（先到先写）+ 工具调用边界强制写；参数可配 |
| Q7 | SSE 读 Redis | 每 SSE 连接独立 `XREAD BLOCK`，不做进程内共享读者扇出（Redis 连接成本低，压测目标量级下 O(连接数) 成立） |
| Q8 | 包边界 | providers/context/prompts/tools 收口进 `app/agent/`，搬迁随 blocks 重写同步完成；`search/`（Tavily 客户端）留原地作为基础设施被 agent 工具引用 |
| Q9 | Redis 资源 | 复用 Celery 的 Redis 实例（确认 `maxmemory-policy noeviction`）；MAXLEN ~2048、终态 EXPIRE 600s、首写兜底 TTL 24h，全部可配；架构按 ≥1000 并发设计，初值按 1C2G 取保守 |
| Q10 | 运行时纯度 | `AgentRunner` 完全不碰 DB：转写作为 `RunResult.transcript` 结束时一次性落库（中间 turn 转写无读者，行为无损）；"run 是否仍活着"的检查统一收编进 `CancellationToken`（由 heartbeat 循环驱动） |
| Q11 | 标题任务 | Provider 协议提供 sync 非流式调用路径（openai SDK 双客户端），Celery 任务全程同步、DB 走既有 sync engine；配置复用同一套 Settings |
| Q12 | 契约与遗留 | SSE 事件格式与 `/state` 恢复端点逐字节冻结（前端零改动）；`run_events` 存量 delta 行在交付二稳定一周后分批 DELETE |
| Q13 | 回滚策略 | 不做双传输运行时开关；退路 = GHCR 镜像回滚 + Q5 降级模式；上线前压测拦截代码缺陷 |
| Q14 | 验收标准 | 见 Testing Decisions；压测目标 N=200 |

### 术语表（命名裁决，实施时严格遵守）

**消息模型**：`Message(role, blocks)`；`Role = system|user|assistant`；`ContentBlock` =
`TextBlock` | `ReasoningBlock` | `ToolCallBlock(id, name, arguments: dict)` |
`ToolResultBlock(tool_call_id, content, is_error)`。

**Provider 层**：协议 `Provider`（保留）；`ProviderCapabilities`（frozen dataclass，
含 `supports_tool_history`、`supports_reasoning` 等）；流式产出
`StreamEvent = TextDelta | ReasoningDelta | ToolCallDone | StreamDone`
（废弃 `ProviderChunk`/`Finish`/`ToolCallTurn`）；`ReasoningConfig(enabled, effort)`
（废弃 `ThinkingOptions`）；`DeepSeekProvider`（保留）；`ProviderError(code, message)`
（保留）；`resolve_provider`（保留）。

**工具层**：`Tool`（protocol：name/spec/execute）；`ToolSpec`（保留）；`ToolRegistry`；
`ToolResult`（保留，字段随 blocks 调整，状态改用 `is_error` 语义）。

**运行时**：编排器 `AgentRunner`；入参 `RunConfig`（frozen：messages、model、
reasoning、tools、限额）；出参 `RunResult(status, transcript, usage, error)`；
`RunStatus = succeeded|failed|cancelled`；取消信号 `CancellationToken`
（`is_cancelled` + `wait()`）；`build_context`、`build_system_prompt` 名称保留、
迁入 agent 包。

**事件与传输**：内存态事件 `RunEvent(seq, type, payload)`（与 ORM 同名，靠模块路径
区分，事件类型字符串沿用冻结契约）；发射接口 `EventSink`（protocol：`emit(event)`）；
实现 `RedisStreamSink`、`PostgresEventSink`、`FanoutSink`；Redis key
`run:{internal_id}:events`（内部 int id）。

**持久化与配置**：转写表**表名不改**（`run_provider_messages`），但代码域一律用
transcript 词根（`load_transcript`、`RunResult.transcript`），provider_message 一词
从代码中消失；新列 `blocks`；草稿表 `run_drafts`（字段 `run_id` PK、`seq`、`text`、
`reasoning`、`updated_at`，无 draft_ 前缀）；新配置 `run_stream_maxlen`、
`run_stream_ttl_seconds`、`run_stream_orphan_ttl_seconds`、
`draft_checkpoint_interval_seconds`、`draft_checkpoint_max_pending_chars`；删除配置
`worker_delta_batch_window_ms`、`worker_delta_batch_max_chars`、
`sse_fallback_interval_seconds`；Celery 任务 `generate_conversation_title`
（新任务模块 llm_tasks，与 email/media 任务并列）。

**保留词汇**：Run、claim、lease、heartbeat、recover、seq、after_seq、
materialize_assistant_message、SourceRegistry、SearchClient。

### 架构要点

- **agent 内核分层**：`app/agent/` 内含 messages / provider / tools / runtime /
  events 五个概念 + providers 与 tools 子包。明确不做：图编排、chain、callback 体系、
  memory 抽象、多 agent。
- **worker 薄适配器**：claim run → 组装 `RunConfig` → 提供 EventSink 实现与
  heartbeat 驱动的 `CancellationToken` → 调用 `AgentRunner.run` → 处理终态与转写落库。
  租约/心跳/恢复机制不变。
- **删除批窗口**：provider 每个 chunk 直接 XADD（微秒级追加），即时性由 provider
  产出节奏决定；原批窗口机制连同其配置一起删除。
- **seq 与恢复**：客户端重连带 `after_seq` → 优先 `XRANGE` 从 Redis 补齐 → 转
  `XREAD BLOCK` 实时跟随；Redis 无数据时降级读 `run_drafts` checkpoint（含 seq），
  拿到快照后从 Redis 续 seq 之后的部分。`/state` 端点改为 checkpoint + Redis 增量拼装。
- **run_events 分工（交付二后）**：只写语义事件（run_started / tool_call_* /
  run_succeeded / run_failed / run_cancelled），delta 不落库；语义事件同时写 PG 与
  Redis（经 FanoutSink）。
- **邮件栈先例对齐**：Redis 仅作加速器/广播，PG 永远是事实源；这一约定连同新任务
  归属判据（流式/交互/可中途取消 → 自研 async 运行时；有限/非流式/可重试 → Celery）
  写入 docs。

## Testing Decisions

**测试哲学**：只测外部行为，不测实现细节。"行为不变"的证词是存量测试套件——
交付一的硬性验收是全量存量测试**不改断言**通过；确需修改的测试（如 import 路径类
非行为断言）必须在 PR 中逐条说明理由。

**三层测试缝（已与所有者确认，Q14）**：

1. **`AgentRunner` 纯内存缝（新增，最高价值）**：FakeProvider + FakeSink +
   FakeToolRegistry + 受控 CancellationToken，覆盖多轮工具循环、取消时机（首 delta 前
   /流中/工具执行中）、provider 异常、工具异常、限额触顶。零 DB、零网络、确定性。
2. **持久化转换缝**：blocks 新格式写读往返 + 存量 wire format 行读取时转换的新旧
   对照测试（现有 transcript 测试为先例）。
3. **API/SSE 端到端缝（沿用存量缝）**：现有 conversations/runs 路由测试风格；交付二
   新增场景——正常流、`after_seq` 重连补齐、取消、工具事件、**手动停 Redis 的降级模式**
   （对话仍完成、checkpoint 粗粒度可见、恢复后新 run 回细粒度），能自动化的写集成测试，
   其余作为手工验收清单。

**性能验收（交付二）**：复用现有生产并发压测脚本，N=200，对比重构前基线：PG 连接
占用与查询次数显著下降、首字节延迟不劣化。上线后观察一周（Redis 内存、降级触发日志）
再执行 delta 清理。

**先例参考**：backend tests 与 dev DB 共享——跑 pytest 前先停 worker（既有约定）；
provider 适配器测试沿用 mock transport 注入模式（openai SDK 接受自定义 http_client）。

## Out of Scope

- **阶段 4 遗留项**：共享租约模块（claim/lease/recover 代码收敛，4a——两处实现
  差异实质、rule of three 未满足）与失败观测字段统一（4c，依附 4a）。待第三个
  需要租约的任务类型出现或交付二稳定后另立 PRD。唤醒信号迁 Redis（4b）已收编为
  ticket 08，不在此列。
- **断点续跑**：worker 崩溃后从 checkpoint 恢复生成——provider 不支持，明确不做。
- **熔断器**：Redis 降级路径上的熔断优化，观察到真实拖慢再议。
- **惰性归档消费者**：完整 delta 历史的 consumer-group 归档（回放/质量分析用），
  记录备查，现在不建。
- **SSE 契约任何变更**：delta 合并格式、降级标识事件等诱惑一律不做。
- **多 agent、图编排、LangChain 系框架引入**：已评审否决。
- **前端任何改动**。
- **转写表 rename**：表名保留，只在代码词汇层统一 transcript。

## Further Notes

- **依赖链**：`01(约定文档) 独立`；`02(内核类型+provider) → 03(转写 blocks) →
  04(AgentRunner 抽取)` 构成交付一；`05(标题 Celery)` 依赖 02；`06(Redis Stream)`
  依赖 04，独立交付；`08(唤醒迁 Redis)` 依赖 06；`07(delta 清理)` 依赖 06，
  **执行时机由所有者决定，不阻碍本批次完成判定**。
- **单 provider 风险**：抽象正确性在接入第二个 provider 前无法完全检验；缓解手段是
  按 Anthropic/OpenAI/Gemini 三家 API 对照建模 + FakeProvider 测试，不能消除。
- **词汇表维护**：实施时把 Run/转写（transcript）/草稿（draft）/agent 内核等新词
  收入根 `CONTEXT.md`（当前只覆盖账户域）。
- **openai SDK 注意点**：DeepSeek 非标字段（reasoning_content、thinking、
  reasoning_effort）走 `extra_body` / 无类型属性访问，必须集中收口在适配器内并注释；
  SDK 客户端做成随进程生命周期的单例（顺带修复现状每调用新建 httpx client 的缺陷）。
- **Redis 部署注意点**：复用实例必须确认 `maxmemory-policy noeviction`（Celery broker
  本身要求）；compose 中无需新增服务。

## Ticket 索引

| # | Ticket | Type | Status | Blocked by |
|---|--------|------|--------|------------|
| 01 | 后台任务约定明文化 | docs | completed（2026-07-17，`docs/architecture/background-tasks.md`） | None |
| 02 | agent 内核类型层与 DeepSeek 适配器重写 | refactor | completed（2026-07-17，`app/agent/` 与旧模块并存至 04） | None |
| 03 | 转写持久化 blocks 化（expand-contract） | refactor | ready-for-agent | 02 |
| 04 | AgentRunner 抽取与 worker 薄适配器化 | refactor | ready-for-agent | 02, 03 |
| 05 | 标题生成迁移 Celery | refactor | ready-for-agent | 02 |
| 06 | Redis Stream 流式传输与降级 | feat | ready-for-agent | 04 |
| 07 | 存量 delta 清理与配置删除 | chore | ready-for-human（所有者定时机） | 06 |
| 08 | runs_queued 唤醒信号迁移 Redis | refactor | ready-for-agent | 06 |
