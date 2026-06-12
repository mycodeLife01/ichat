# 2026-06-11 Web Search Tool 交接

## 范围

按 `docs/superpowers/specs/2026-06-11-web-search-tool-design.md` 落地第一版联网搜索工具：

- 前端 Composer 增加“联网搜索”开关，本地记忆；启动时读取 `GET /api/v1/capabilities`，capability 关闭时保留偏好但实际发送 `web_search_enabled=false`。
- 后端新增无认证 capabilities API；send / edit-and-regenerate / regenerate 的 `provider_options` 持久化 `web_search_enabled` 和 `web_search_suppressed_by_user`。
- 新增 Tavily Search/Extract adapter、规则 query planner、source 去重编号和 evidence 压缩。
- Worker 在 web search enabled 的 run 上执行 DeepSeek tools agent loop：支持预搜索、模型主动 tool call、最多 2 次工具调用、搜索软失败、tool events SSE replay、最终 sources metadata。
- 新增完整 provider transcript 表 `run_provider_messages`；成功 run 的历史 context 按 `user message + run_provider_messages` block 原子 replay，并回放 tool-call turn 的 `reasoning_content`。

## 关键文件

后端：

- `alembic/versions/20260611_0005_add_web_search_transcript.py`
- `scripts/web_search_worker_smoke.py`
- `app/api/v1/capabilities.py`
- `app/search/*`
- `app/tools/*`
- `app/providers/types.py`
- `app/providers/deepseek.py`
- `app/worker/executor.py`
- `app/context/builder.py`
- `app/services/runs/transcript.py`

前端：

- `frontend/src/api/capabilities.ts`
- `frontend/src/runs/webSearchPreference.ts`
- `frontend/src/ui/Composer.tsx`
- `frontend/src/runs/state.ts`
- `frontend/src/runs/useRunStream.ts`
- `frontend/src/messages/StreamingMessage.tsx`
- `frontend/src/messages/Message.tsx`

## 数据库变更

新增：

- `runs.system_prompt_snapshot`
- `messages.metadata` JSONB（ORM 内部字段 `metadata_`）
- `run_provider_messages` 表
- `run_events.type` 允许 `tool_call_started`、`tool_call_succeeded`、`tool_call_failed`

迁移已在本地测试库执行：

```bash
DATABASE_URL="postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat" uv run alembic upgrade head
```

## 设计要点

- DeepSeek adapter 只负责协议：发送 tools schema、序列化 provider messages、拼接 streaming tool-call 分片。实际工具执行在 worker。
- 带 tools 的 provider call 会先在 provider 层缓存本次响应：若 finish 为 `tool_calls`，返回完整 `ToolCallTurn`；若是最终回答，再把本轮 reasoning/text 作为 delta 发给 worker。未启用 web search 的普通 run 保持原有逐 token streaming。
- 预搜索是 worker 合成的 provider turn；为满足 DeepSeek thinking mode 的历史回传协议，合成 assistant tool-call message 会保存并回传 `reasoning_content`。
- 搜索失败不使 run failed：worker 写 `tool_call_failed` 和 tool result transcript，然后继续让模型回答。
- 若成功 sources 存在但最终文本没有合法 `[n]` 引用，worker 在物化前追加 `Sources:` / `来源：` 段；第一版只检查引用存在，不做语义校验。
- 历史 context 只 replay succeeded run；failed/cancelled transcript 只用于审计。

## 验证

已执行：

```bash
uv run pytest
uv run ruff check app tests scripts/web_search_worker_smoke.py
uv run mypy app
DATABASE_URL="postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat" \
  WEB_SEARCH_ENABLED=true \
  TAVILY_API_KEY=... \
  uv run python scripts/web_search_worker_smoke.py

cd frontend
pnpm exec vitest run
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：

- 后端：234 passed，2 个第三方/框架 deprecation warnings。
- ruff：All checks passed。
- mypy：Success: no issues found in 61 source files。
- worker smoke runner：真实 Tavily + fake DeepSeek 通过。最后一次默认查询
  `site:openai.com OpenAI latest news`，run 3853，事件链为
  `run_started -> tool_call_started -> tool_call_succeeded -> text_delta -> run_succeeded`，
  `source_count=3`，transcript 角色链为 `assistant -> tool -> assistant`。
- 前端：257 passed；typecheck / lint / build 全绿。
- 真实端到端 smoke：本机当前代码启动 API(`:8001`) / worker / Vite(`:5174`)，
  前端注册 smoke 用户，打开“联网搜索”和 Max，发送
  `请联网搜索 site:openai.com OpenAI 2026 年 6 月最新发布，用中文总结 2 点，并引用来源。`
  浏览器确认：
  - 生成中出现“正在搜索网页...”。
  - 最终回答成功完成，没有“生成失败”。
  - 最终 assistant message 展示 OpenAI 来源链接/source chips。
- DB 端到端 smoke 证据：run 3850 `status=succeeded`，
  `provider_options.web_search_enabled=true`、`thinking_enabled=true`、
  `reasoning_effort=max`；run events 含 `tool_call_started`、
  `tool_call_succeeded`、`reasoning_delta`、`text_delta`、`run_succeeded`；
  assistant message `metadata.sources` 共 5 个来源；最终 assistant provider
  message 已回填 `message_id`。

## 已知边界

- 第一版只实现 Tavily，不做 provider fallback 和缓存。
- 带 tools 的最终回答在本版按 provider response 聚合后写 SSE delta；普通非工具 run 仍维持原有流式 batching。
- 真实端到端 smoke 中，DeepSeek 在已有预搜索结果后仍尝试了额外 tool calls；
  超出预算或非法参数均按设计软失败，最终 run 仍成功，并保留完整 transcript。
