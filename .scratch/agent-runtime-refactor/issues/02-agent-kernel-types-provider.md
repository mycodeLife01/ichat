Type: refactor
Status: completed
Blocked by: None

# agent 内核类型层与 DeepSeek 适配器重写

## 目标

建立 `app/agent/` 包的类型地基：provider 中立的 content-blocks 消息模型、Provider
协议（含 capabilities 与 sync 非流式路径）、Tool 协议与注册表；DeepSeek 适配器换用
openai SDK 重写并收编全部 provider 怪癖。命名严格遵守 PRD 术语表。

## 范围

1. **消息模型**：`Message(role: system|user|assistant, blocks)`；blocks =
   `TextBlock | ReasoningBlock | ToolCallBlock(id, name, arguments: dict) |
   ToolResultBlock(tool_call_id, content, is_error)`。工具结果归入 user 消息
   （Anthropic 式，Q2）。建模前对照 Anthropic/OpenAI/Gemini 三家消息 API 校验
   可无损映射。
2. **Provider 协议**：流式 `stream(...) -> AsyncIterator[StreamEvent]`
   （`TextDelta | ReasoningDelta | ToolCallDone | StreamDone`）；非流式 sync 路径
   （供 Celery 任务使用，Q11）；`capabilities: ProviderCapabilities`
   （`supports_tool_history`、`supports_reasoning`）；`ReasoningConfig(enabled, effort)`。
3. **DeepSeek 适配器**：openai SDK（AsyncOpenAI + OpenAI 双客户端，进程级单例）；
   删除手写 SSE 解析器；非标字段（reasoning_content/thinking/reasoning_effort）经
   `extra_body` 与属性访问集中收口并注释；「历史中剥离 tool 消息」的怪癖从 context
   层收编进适配器（blocks→wire 翻译时按 capabilities 处理），`include_tool_messages`
   穿透参数消失。
4. **工具层**：`Tool` 协议 + `ToolRegistry`；web_search 迁入 agent 包工具子包并适配
   blocks 模型（`search/` 留原地被引用）；`ToolResult` 改用 `is_error` 语义。
5. **迁移搬运**：context/prompts 构建器迁入 agent 包（`build_context` 返回
   `list[Message]`）。旧顶层包在交付一内保持 re-export 或直接更新全部 import
   （二选一，以存量测试不改断言为准绳）。

## 验收

- `pytest`、`ruff check .`、`mypy app` 全绿；存量测试不改断言（import 路径类修改
  需在 PR 说明）。
- 新增：blocks 模型与三家 API 映射的往返测试；DeepSeek 适配器 mock transport 测试
  （openai SDK 注入自定义 http_client，沿用现有模式）；FakeProvider 落地并被至少
  一个测试使用。
- dev 环境手工验证一条真实对话（web search 开/关各一次）端到端跑通。

## Comments

- 2026-07-17 完成（commit `5505bc8`）。采用并存/expand 策略：`app/agent/` 内核与旧 `app/providers|context|prompts|tools` 并存，worker 仍跑旧路径，存量测试零改动；旧模块删除归 ticket 04。三处经所有者评审的偏离/裁决：(1) 内核 `build_context` 为纯函数（DB 读取下沉 `app/services/runs/history.py`，依据 User Story 8）；(2) `ToolResult` 收敛为 `content + is_error + metadata`，不设工具特例字段，`ToolContext` 不引入；(3) 上下文接口用扁平 `list[Message]`，turn 边界为裁剪内部实现。已对真实 DeepSeek+Tavily 做 web search 开/关端到端验证。交接详情见 `docs/handover/2026-07-17-agent-runtime-refactor-issue01-02.md`。
