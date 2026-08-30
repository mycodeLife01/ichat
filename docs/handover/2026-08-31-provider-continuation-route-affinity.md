# Provider 续传按路由亲和隔离

## 结果

同一会话现在可以安全穿插 Grok、Gemini、DeepSeek 官方与 OpenRouter 路径。完整 transcript 仍作为不可变事实保存在 PostgreSQL；发送给目标 Run 前，历史按 Provider 续传阶段投影，跨路径只传精确用户输入与最终助手正文，不再把旧模型的 `reasoning.encrypted`、原始/摘要推理、工具调用或工具结果带给新路径。

OpenRouter 新返回的 `reasoning_details` 保存为 `reasoning_details.v2`，payload 内带规范化 base URL + provider model 的 replay key。Adapter 只有在当前请求匹配时才回放；存量 v1 继续读取，并由历史投影保证只会进入兼容阶段。无需数据库迁移或清理历史数据。

## 故障现场与根因

本地开发库的 `run_id=8954` 属于 conversation 9072，目标路径为 OpenRouter `google/gemini-3.7-flash`。同一分支之前的 8950、8951 使用 OpenRouter Grok 成功，transcript 中分别存在 `xai-responses-v1` 的加密 reasoning detail；8954 在任何输出前即收到 OpenRouter 404，错误指出加密 reasoning/compaction payload 由另一模型 endpoint 创建。

这里的 `reasoning.encrypted` 是上游为了隐藏内部推理同时允许工具续接而返回的不透明状态，不是 iChat 加密用户正文，也不是数据库 compaction。原实现的问题有两层：

1. `services/runs/history` 对所有成功 Run 原样回放完整 transcript，不区分目标路由。
2. OpenRouter Adapter 只校验 continuation 的 `owner=openrouter` 与 codec；它把网关误当成兼容域，因此把 Grok 的加密块发送给 Gemini。

单独删除 encrypted detail 不是合法修复：OpenRouter 要求同一 assistant message 的 `reasoning_details` 完整、原序回传；DeepSeek 官方还使用独立的 `reasoning_content` 与工具历史规则。只过滤某个 detail type 会留下其他 provider 私有状态并破坏协议序列。

## Provider 续传阶段

目标 Run 的亲和 key 是：

```text
(adapter, upstream, normalized_base_url, provider_model)
```

历史层从目标用户消息之前向后扫描成功 Run：

- key 相同的连续成功后缀属于当前阶段，完整保留 reasoning、continuation、tool call/result 与最终正文；
- 遇到第一个成功但 key 不同或快照未知的 Run 即结束当前阶段；
- failed/cancelled Run 不建立新 provider 状态，因此不作为切换屏障，但仍只保留其精确用户输入，绝不回放 partial assistant 输出；
- 当前目标 Run 同样只读取创建时持久化的精确用户输入；
- 所有投影都创建新的内存 Message/block list，在上下文预算裁剪前完成，不更新 JSONB 或 ORM 行。

阶段外的成功 Run 折叠成一个可移植 turn：首条精确用户输入（文字、文档、图片和附件提示）加最后一条 assistant message 的非空 TextBlock；推理、续传块、中间 assistant tool message 和 ToolResultBlock 全部移除。没有最终正文时只保留用户输入。

典型序列：

```text
Grok₁ → Gemini₁ → Grok₂ → Grok₃
[阶段 A]  [阶段 B]  [阶段 C────────]
```

Grok₂ 不会复活 Grok₁ 的加密状态；Grok₃ 可以续用 Grok₂ 新产生的状态。若 Gemini 尝试失败，则它不结束仍在延续的 Grok 阶段。

## DeepSeek 路径矩阵

| 前一路径 | 目标路径 | 历史投影 |
|---|---|---|
| DeepSeek 官方，同 upstream/base URL/model | DeepSeek 官方同路径 | 完整保留 `reasoning_content` 对应的 raw reasoning 与工具协议 |
| DeepSeek 官方 | OpenRouter DeepSeek | 可移植 turn；官方 `reasoning_content`/工具状态不进入 OpenRouter |
| OpenRouter DeepSeek | DeepSeek 官方 | 可移植 turn；`reasoning_details` 不进入官方接口 |
| OpenRouter DeepSeek，同 upstream/base URL/model | OpenRouter 同路径 | 完整保留匹配的 `reasoning_details` |
| 任一路径切走后再切回 | 原路径 | 开始新阶段，不恢复切换前不透明状态 |

即使上游 model id 看起来属于同一 DeepSeek 家族，官方 Adapter 与 OpenRouter Adapter 也不是同一兼容域。

## OpenRouter 二次防线与错误语义

- 新块 codec 为 `reasoning_details.v2`；外层 `ProviderContinuationBlock` schema 不变，旧代码反序列化不会失败，回滚版本只会忽略未知 v2 codec。
- replay key 使用规范化 base URL 与当前 provider model 的稳定摘要，不保存 API key，也不把 endpoint/model 明文复制进 payload。
- Adapter 仍支持 v1，以便兼容现有 transcript；v1 是否到达 Adapter 由历史阶段投影决定。
- 若上游仍返回“encrypted payload from a different model/endpoint”，Adapter 将其映射为 `openrouter_continuation_incompatible`，错误消息不包含 `pinned_endpoint_slug` 等上游元数据。
- Worker 对该错误不执行零输出自动重试，更不会“剥离后再试”；活跃工具续接中盲删状态可能改变语义。

## 数据、发布与回滚

- 无 Alembic migration，无数据回填，无 transcript 删除或 JSONB 更新。
- `run_id=8954` 保留为历史失败事实；部署后应从对应用户消息重新生成，不应把旧 Run 改回 queued。
- 代码更新只影响流式 LLM Worker。发布时重建并 force-recreate 全部 `worker` 副本；API、Celery 与前端无需因本修复重建。
- 回滚不会遇到 schema 不兼容，但旧代码会重新失去 v1 的路由阶段保护。观察期内若必须回滚，应暂停跨模型复用同一会话或从新会话继续，不能通过删除 transcript 规避。

## 验证

已完成：

```bash
uv run pytest tests/services/runs/test_history.py \
  tests/agent/test_openrouter_adapter.py tests/worker/test_executor.py -q
# 49 passed

uv run pytest tests/agent tests/services/runs tests/worker -q
# 173 passed

uv run pytest -q
# 734 passed, 51 warnings

uv run mypy app
# Success: no issues found in 140 source files

uv run ruff check .
git diff --check
docker compose config -q
# all passed

docker compose up -d --build --force-recreate worker
# worker-1 / worker-2 both running image
# sha256:6b9b04271b6d6375e526d580bae2d2adb5861525032d35f67e36312cef28de06
```

回归覆盖同路径完整回放、Grok → Gemini、Grok → Gemini → Grok → Grok、adapter/upstream/base URL/model/未知快照屏障、失败 Run 非屏障、附件保留、空最终正文、DeepSeek 官方 ↔ OpenRouter、v1 兼容、v2 endpoint/model key、OpenRouter 专用错误与禁止重试。真实供应商 smoke 仍应在部署凭据范围内执行：至少验证 Grok → Gemini 成功、Gemini → Grok 成功、连续 Grok 工具续接和 DeepSeek 官方/OpenRouter 各自的连续工具续接。

Compose 因 `worker` 的依赖关系执行了一次现有 `migrate` service，结果为无变更的 `alembic upgrade head`；本修复没有新增 revision。重建后两个 Worker 的 queue/cancel listener 均正常启动，`run_id=8954` 仍为 `failed/openrouter_http_error`，未被重排队或改写。

另外在新 Worker 容器内只读调用 `load_conversation_history(run_id=8954)`：返回 4 条可移植消息，`ProviderContinuationBlock`、`ReasoningBlock`、`ToolCallBlock`、`ToolResultBlock` 计数均为 0。这证明原来会发往 Gemini 的 Grok 私有协议块已从实际请求投影中移除，同时数据库 transcript 保持原样。
