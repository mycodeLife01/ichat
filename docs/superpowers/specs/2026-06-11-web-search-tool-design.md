# Web Search Tool 设计

日期：2026-06-11

## 背景

iChat 当前后端由 API、worker、PostgreSQL 三部分组成。API 只负责接收请求、写入 message/run 并通过 Postgres 唤醒 worker；DeepSeek 流式调用、run 状态推进、SSE event 持久化都发生在 worker。此前 provider 抽象已支持 `text_delta`、`reasoning_delta`、`Finish`，并通过 `runs.provider_options` 持久化每次请求的 thinking 配置。

本设计在这个架构上接入 Tavily 作为第一版 Web Search provider，并将能力建模为 DeepSeek tool calling。目标不是简单地在 prompt 前拼搜索结果，而是支持完整的 provider transcript：thinking + tool calls 的中间 assistant turn、tool result、最终 assistant answer 都被持久化，后续成功 run 的历史上下文可以按 provider 协议重放。

DeepSeek 官方文档说明，思考模式下发生 tool call 后，后续请求需要完整回传该 assistant message 中的 `reasoning_content`、`content`、`tool_calls` 以及对应 tool result。因此本版选择完整持久化 provider transcript，而不是只保存最终可见回答。

参考：

- DeepSeek Tool Calls: <https://api-docs.deepseek.com/zh-cn/guides/tool_calls>
- DeepSeek 思考模式: <https://api-docs.deepseek.com/zh-cn/guides/thinking_mode>
- Tavily Search API: <https://docs.tavily.com/documentation/api-reference/endpoint/search>
- Tavily Extract API: <https://docs.tavily.com/documentation/api-reference/endpoint/extract>

## 目标

1. 前端提供显式“联网搜索”开关，默认关闭并本地记忆。
2. 后端按 run 持久化 `web_search_enabled`，worker 根据实际选项决定是否提供 `web_search` tool。
3. 支持 DeepSeek thinking + tool calls，完整保存 provider transcript。
4. 搜索能力抽象为 provider-agnostic search client，第一版实现 Tavily Search + Extract。
5. 搜索结果经过 query planning、搜索/抽取、去重、压缩、编号后回填给模型。
6. 最终 assistant message 保存结构化 `metadata.sources`，前端展示来源 chips。
7. SSE replay 能恢复生成中的工具状态。
8. 搜索失败全部软失败，继续生成并让最终回答说明未拿到实时网页信息。
9. 后续 succeeded run 的 provider transcript 能作为历史 block 原子进入 context builder。

## 非目标

- 不实现多个搜索 provider 的 fallback。
- 不让前端或用户选择 search provider。
- 不做搜索缓存。
- 不公开 provider transcript API。
- 不保存 Tavily 原始响应或完整网页正文。
- 不做引用内容的语义级校验。
- 不引入 LangChain/LangGraph/Celery/Redis。

## 总体方案

采用“完整 provider transcript + 历史 block replay”方案。

API 仍保持薄层：接收请求、解析 run options、创建 run。worker 拥有 tool runtime：构建 context、检测预搜索意图、执行 Tavily Search/Extract、推进 DeepSeek agent loop、写 run events、写 provider transcript、物化最终 assistant message。

模块划分：

```text
app/search/
  types.py          # SearchRequest/SearchResult/ExtractRequest/ExtractResult 等统一类型
  client.py         # SearchClient Protocol / ABC
  registry.py       # resolve_search_client(name)
  tavily.py         # TavilySearchClient
  query_planner.py  # 规则 query planner / intent detector
  postprocess.py    # 去重、排序、证据压缩、source 编号

app/tools/
  types.py          # ToolSpec/ToolCall/ToolResult 等 worker 内部类型
  web_search.py     # web_search tool runtime
  runtime.py        # 执行 provider tool call，维护 per-run tool budget/source registry
```

DeepSeek provider 只负责协议收发：发送 `tools` schema，解析 streaming 中的完整 tool call、reasoning/content/finish reason。工具执行不进入 provider adapter。

## API 与前端行为

### Run options

`RunOptionsRequest` 新增：

```json
{
  "web_search_enabled": true
}
```

发送消息、编辑后重新生成、重新生成都使用当前前端开关状态。和 thinking 设置一样，它是新 run 的配置，不沿用旧 run。

如果用户消息显式包含“不要联网/不要搜索”等否定意图，即使本地开关为开，本 run 也禁用联网，并持久化实际行为：

```json
{
  "web_search_enabled": false,
  "web_search_suppressed_by_user": true
}
```

前端不因为这次消息改变本地开关，也不额外提示。

### Capabilities

新增公开能力接口：

```http
GET /api/v1/capabilities
```

无需认证，不暴露 provider 名：

```json
{
  "data": {
    "web_search": {
      "enabled": true
    }
  }
}
```

前端启动后读取 capabilities。若 disabled，保留本地偏好但禁用 UI，实际发送 `web_search_enabled=false`。后端 `WEB_SEARCH_ENABLED` 仍是最终兜底。

### 前端展示

Composer 增加联网搜索开关。默认关闭，本地记忆上次状态。

生成中显示工具状态：

- `tool_call_started`：显示“正在搜索网页...”和 query。
- `tool_call_succeeded`：显示“已找到 N 个来源”，预览 2-3 个来源标题。
- `tool_call_failed`：显示搜索失败的用户可读信息。

最终 assistant message 底部显示 source chips：标题 + 域名。`snippet`、`published_at` 保存在 metadata 中，第一版不展开显示。

## 数据模型

一个 Alembic migration 完成所有 schema 变更。

### runs

新增：

```text
system_prompt_snapshot TEXT NULL
```

run 创建时保存当前 system prompt，用于审计。system snapshot 不作为历史 provider message replay；每个新 run 仍只注入当前 `DEFAULT_SYSTEM_PROMPT`。

`provider_options` 继续作为 per-run 选项容器，新增：

```json
{
  "thinking_enabled": true,
  "reasoning_effort": "max",
  "web_search_enabled": true,
  "web_search_suppressed_by_user": false
}
```

### messages

新增 JSONB 列：

```text
metadata JSONB NULL
```

SQLAlchemy declarative 内部使用 `metadata_ = mapped_column("metadata", JSONB)`，API/DB 对外字段仍叫 `metadata`。

最终 assistant message 的 metadata 保存成功 sources：

```json
{
  "sources": [
    {
      "id": 1,
      "title": "...",
      "url": "...",
      "snippet": "...",
      "published_at": "...",
      "provider": "tavily"
    }
  ]
}
```

搜索失败不进入 message metadata，只在 run events 和最终文本中体现。

### run_provider_messages

新增表，一行一个 provider 协议消息：

```text
id BIGINT PK
run_id BIGINT NOT NULL FK runs(id) ON DELETE CASCADE
seq INTEGER NOT NULL
message_id BIGINT NULL FK messages(id) ON DELETE SET NULL
role VARCHAR(20) NOT NULL        # user/assistant/tool
content TEXT NULL
reasoning_content TEXT NULL
tool_call_id VARCHAR(255) NULL
tool_name VARCHAR(100) NULL
tool_calls JSONB NULL
payload JSONB NULL
estimated_tokens INTEGER NOT NULL DEFAULT 0
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

约束与索引：

- unique `(run_id, seq)`
- index `(run_id, seq)`
- index `(message_id)`
- role check：`user`、`assistant`、`tool`

语义：

- 所有 runs 都保存最终 assistant provider message。
- 工具 run 额外保存中间 assistant tool-call turn 和对应 tool result。
- 中间 assistant tool-call turn 通常 `message_id=NULL`。
- 最终 assistant provider message 在物化 `messages` 后回填 `message_id`。
- `role="tool"` 的 `content` 保存完整压缩 evidence 或工具错误结果。
- `payload` 保存 provider-agnostic 附加结构，例如 normalized args、source ids、error code。
- `estimated_tokens` 写入时用 provider token estimator 估算，用于审计和未来预算优化；context builder 仍以构建时估算为准。

### run_events

扩展 `type_valid` check，新增：

```text
tool_call_started
tool_call_succeeded
tool_call_failed
```

首个 tool event 也触发 run `started -> streaming`。

成功事件 payload 轻量保存来源摘要：

```json
{
  "tool_name": "web_search",
  "query": "...",
  "provider": "tavily",
  "result_count": 5,
  "sources": [
    { "id": 1, "title": "...", "url": "..." }
  ]
}
```

失败事件 payload 带用户可读信息：

```json
{
  "tool_name": "web_search",
  "query": "...",
  "provider": "tavily",
  "error_code": "timeout",
  "message": "Web search timed out. Continuing without live results."
}
```

`tool_call_started` 在 query planner/validator 确定实际执行 query 后写入，不展示 raw model args。

## Worker 执行流

### run 初始化

1. 加载 run、provider options、provider。
2. 启动 heartbeat/cancel 覆盖整个 agent loop。
3. 构建 provider messages：
   - 当前 system prompt。
   - 历史 succeeded blocks。
   - 当前用户消息。
4. 如果本 run 实际允许 web search，构建 DeepSeek `tools=[web_search]`。
5. 如果全局关闭或配置缺失，工具不可用时走软失败语义。

### SearchIntentDetector

第一版为规则 detector，不调用 LLM。

触发预搜索的信号包括：

- 显式搜索：联网、搜索、查一下、查网页、source、cite、引用来源。
- 时间敏感：今天、现在、最新、recent、latest、current、今年、刚发布。
- 易变领域：价格、汇率、新闻、天气、股票、版本、release、API docs、官网文档。
- URL、裸 domain、`site:domain`。

反向信号包括：

- 用户明确说不要联网、不要搜索。
- 纯写作、翻译、改写、代码解释等没有外部信息需求的场景。

即使 `must_search=false`，只要本 run 允许 web search，DeepSeek 仍可自行调用 `web_search`。

### 预搜索

若 `web_search_enabled=true` 且 detector 判定 `must_search=true`，worker 在第一次 DeepSeek 调用前执行一次内部 `web_search`。预搜索计入最多 2 次工具调用。

预搜索结果以 provider-agnostic tool result 形式加入 provider messages，并写入 `run_provider_messages`。同时写 `tool_call_started`、`tool_call_succeeded` 或 `tool_call_failed` run event。

### DeepSeek agent loop

每个 run 最多 2 次 `web_search`，预搜索计入次数。

循环：

1. 调用 DeepSeek streaming。
2. 如果返回中间 tool-call assistant turn：
   - provider 层拼完整 tool calls、content、reasoning_content。
   - worker 写 `run_provider_messages(role="assistant", tool_calls=..., reasoning_content=...)`。
   - 不向前端发送 `reasoning_delta/text_delta`。
   - 执行 tool call，写 tool result transcript。
   - 继续下一次 DeepSeek 调用。
3. 如果返回最终 assistant answer：
   - 仅最终回答轮向前端流式发送 `reasoning_delta/text_delta`。
   - 写最终 assistant provider message。
   - 成功时物化 assistant message，写 `metadata.sources`，回填 transcript `message_id`。

中间 tool-call assistant turn 的 `content` 即使非空也不作为用户可见文本展示。

### 取消

用户取消覆盖搜索、extract、DeepSeek 流式阶段。HTTP task 应尽快响应 cancellation；随后通过已有 lifecycle 写 `run_cancelled`。

## Context Builder 与历史 replay

历史 context 只 replay `succeeded` run。failed/cancelled 的 transcript 只保留审计，不进入后续模型上下文。

上下文按 block 原子裁剪：

```text
block = user message + corresponding run_provider_messages for succeeded run
```

预算不足时，从最旧 block 整块丢弃，不保留半截 tool call 链。

历史 replay 回放所有保存的 `reasoning_content`。这保证 thinking + tool call 历史在后续 provider 请求中保持协议完整。system message 不从历史 transcript 中 replay；每个新 run 只注入当前 system prompt。

## Web Search 工具

### Tool schema

模型只看到一个工具：

```json
{
  "name": "web_search",
  "parameters": {
    "query": "string",
    "max_results": "integer",
    "include_domains": ["string"],
    "exclude_domains": ["string"],
    "recency": "day|week|month|year|none",
    "search_depth": "basic|advanced",
    "extract": true
  }
}
```

模型可传 `extract=true`，worker 负责限额、校验、超时。

### 参数校验

worker 校验模型参数：

- 空 query。
- 超长 query。
- 非法 domain。
- `max_results` 超限。
- 非法 `recency/search_depth`。
- schema 外或类型错误字段。

校验失败时：

1. 写 `tool_call_failed(validation_error)`。
2. 写 provider transcript 的 `tool` result，内容说明参数错误。
3. 让模型有机会重新调用一次工具。
4. 这次失败计入最多 2 次工具调用。

### Query planner

第一版只做规则提取，最多生成 1 个 query：

- 清理寒暄和明显无关文本。
- 根据当前日期补充实时语境。
- 识别 URL、裸 domain、`site:domain`。
- 不做多 query 拆分。
- 不调用 LLM rewrite。

URL 场景：

- “总结/分析这个链接”走 direct extract。
- “这个站有没有 X”走 domain search。
- direct extract 失败时 fallback 到 URL/domain search。

### Search 与 Extract

第一版 Tavily adapter 实现 Search + Extract。

抽象参数不泄漏 Tavily 细节：

- `depth=basic|advanced`
- `max_results`
- `include_domains/exclude_domains`
- `recency`
- `extract`

Tavily adapter 内部映射到 Tavily Search/Extract 参数。

默认策略：

- search 默认 `basic`。
- 强实时/高准确场景或工具参数要求时可用 `advanced`。
- 默认不 extract。
- 用户要求官方文档、新闻详情、引用来源、URL 分析、API 版本等高准确场景时预搜索可 extract。
- 模型主动调用时可传 `extract=true`。
- extract 最多 top 2-3 个结果。

### Evidence 压缩与 sources

DeepSeek 只接收 provider-agnostic 压缩 evidence，不接收 Tavily raw。

证据格式使用中文结构说明，证据内容保持原文，不翻译标题/snippet/extract 片段。最终回答语言跟随用户。

source 编号在整个 run 内统一递增。两次搜索之间 URL 去重，重复来源保留同一编号。

第一版压缩策略为规则截断：

- 每 source 最大字符数。
- 总 evidence 最大字符数。
- raw extract 全文不入库。
- 未来可扩展 LLM summarization。

如果本 run 有成功 sources，但最终文本没有任何合法 `[n]` 引用，worker 不重调模型，只在物化前追加来源段：

- 中文用户：`来源：...`
- 英文用户：`Sources: ...`

只校验是否存在引用，不校验每个引用的语义支撑关系。

## 错误处理

所有搜索相关错误第一版软失败继续回答：

- `WEB_SEARCH_ENABLED=false`
- provider 配置缺失
- Tavily timeout
- Tavily 429/5xx
- Search/Extract 网络错误
- Extract 失败并 fallback search 也失败
- 参数校验失败
- 工具调用次数耗尽

软失败行为：

1. 写 `tool_call_failed`。
2. 写 provider transcript 的 `tool` result，说明失败原因。
3. 继续 DeepSeek agent loop。
4. 最终回答需要说明未能获取实时网页信息。

如果工具失败后模型仍继续凭已有上下文回答，这不是 run failed。只有非搜索链路的致命错误才走现有 `mark_run_failed`。

## 配置

新增配置：

```env
WEB_SEARCH_ENABLED=false
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=
TAVILY_BASE_URL=https://api.tavily.com
WEB_SEARCH_MAX_TOOL_CALLS=2
WEB_SEARCH_SEARCH_TIMEOUT_SECONDS=12
WEB_SEARCH_EXTRACT_TIMEOUT_SECONDS=8
WEB_SEARCH_TOTAL_TIMEOUT_SECONDS=25
WEB_SEARCH_DEFAULT_MAX_RESULTS=5
WEB_SEARCH_MAX_EXTRACT_RESULTS=3
WEB_SEARCH_MAX_EVIDENCE_CHARS=10000
WEB_SEARCH_MAX_SOURCE_CHARS=1200
```

第一版不支持 fallback providers，不支持 per-request provider selection。

日志记录完整 query、provider、result count、latency、error_code。日志不记录完整 extract 正文、Tavily raw、完整 evidence。

## 测试策略

CI 只使用 mock，不依赖真实 Tavily key 或外网。

后端测试覆盖：

- DeepSeek streaming tool call 分片拼接。
- thinking + tool call transcript 保存。
- tool 参数校验失败写 event + tool result。
- Tavily Search adapter mock。
- Tavily Extract adapter mock。
- direct extract 失败 fallback search。
- 搜索软失败继续回答。
- 配置缺失软失败。
- 最多 2 次工具调用。
- 取消覆盖 search/extract/model 阶段。
- source 编号、去重、metadata 写入。
- 引用缺失时追加来源段。
- `run_provider_messages.message_id` 回填。
- context builder 按 succeeded block 原子截断。
- history replay 回放 reasoning_content/tool result。
- capabilities API 无认证且不返回 provider。

前端测试覆盖：

- capabilities disabled 时保留偏好但禁用 UI，实际发送 false。
- 联网搜索开关本地记忆。
- send/edit/regenerate 发送当前 `web_search_enabled`。
- tool events 更新生成中状态。
- `tool_call_succeeded` 展示 2-3 个来源标题预览。
- assistant message 展示 source chips。
- SSE replay 恢复 tool 状态。

手动 smoke：

- 后端 worker smoke：真实 Tavily + fake/real DeepSeek 跑一次 web_search run，验证 DB/events/sources。
- 端到端 smoke：前端开关 + 后端 + worker + real DeepSeek/Tavily 完成一次真实聊天。
- 最终验收跑端到端 smoke。

## 文档更新

实现阶段需要同步更新：

- `.env.example`
- `docs/deployment.md` 中生产 env 与开关说明
- 对应 handover 文档

## 成功标准

1. 用户打开联网搜索后，明显需要实时信息的问题会先搜索，再回答。
2. 用户打开联网搜索但问题不需要实时信息时，模型仍可自行决定是否调用 `web_search`。
3. 用户明确说不要联网时，本 run 不提供工具且不改变本地开关。
4. 搜索状态通过 SSE 可 replay。
5. 最终回答能展示结构化来源。
6. thinking + tool calls 的 provider transcript 完整持久化。
7. 后续 succeeded history 能按 block 原子 replay provider transcript。
8. 搜索失败不会让聊天中断。
9. 新搜索 provider 可通过新增 `SearchClient` adapter 接入，无需改 DeepSeek tool schema。
