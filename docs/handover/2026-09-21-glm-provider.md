# GLM 上游 Provider 接入

## 结果

GLM（智谱开放平台 BigModel）现在是数据库模型目录的一个一等上游适配器：`/model-admin` 与应急 CLI 可创建 `glm` 上游、逻辑模型与路由，流式 Worker 通过新增的 `glm` 代码适配器直连 `https://open.bigmodel.cn/api/paas/v4/chat/completions`。GLM 的思考输出按 `raw` 推理呈现，工具续接按官方要求回放 `reasoning_content`，保留式思考（`clear_thinking: false`）随请求启用。

计划中的两个待验证项已实测：GLM 接受共享基类的 `stream_options: {"include_usage": true}` 与 `image_url.detail: "high"`，无需 fallback，相关现状锁定断言保留。实施依据见 [GLM 接入计划](../plans/2026-09-21-glm-provider.md)。

## 实现

| 文件 | 内容 |
| --- | --- |
| `app/agent/providers/glm.py` | `GLMProvider(OpenAIChatCompletionsProvider)`：`thinking`/`clear_thinking` 请求体、顶层 `reasoning_effort` 原样透传、`delta.reasoning_content` → raw 推理、`_replay_reasoning_in_history=True`、`supports_tool_history=False` |
| `app/services/agents/registry.py` | `ProviderAdapter` Literal 与 `build_provider` 增加 `glm` |
| `app/services/model_catalog/service.py` / `management.py` | `_ADAPTERS`、`_ADAPTER_REASONING_OUTPUTS["glm"] = {"raw"}` |
| `app/models/model_catalog.py` + `alembic/versions/20260921_0025_allow_glm_adapter.py` | `adapter_valid` CHECK 增加 `'glm'`；downgrade 在存在 `adapter='glm'` 行时 fail-closed 拒绝 |
| `app/schemas/model_admin.py`、`app/model_admin.py` | 管理 API schema 与 CLI choices |
| `frontend/src/api/modelAdmin.ts`、`frontend/src/model-admin/ModelAdminEditors.tsx` | adapter 类型、下拉、glm 路由默认推理输出 `raw` |

不产生 `ProviderContinuationBlock`：GLM 续传协议是明文 `reasoning_content` + 标准 `tool_calls`，由 ADR 0013 路由亲和投影与回放 flag 覆盖。`finish_reason`（含 `sensitive`/`network_error`）按字符串透传。

## 验证

质量门（全部通过）：

```bash
uv run ruff check .                      # passed
uv run pytest -q                          # 798 passed, 54 warnings（隔离 PostgreSQL 16.9）
uv run pytest -q tests/agent              # 95 passed
uv run pytest -q tests/services/model_catalog  # 16 passed（真实事务）
uv run pytest -q tests/api/test_model_admin.py  # 6 passed
DATABASE_URL=<isolated> uv run alembic upgrade head    # 含 20260921_0025
DATABASE_URL=<isolated> uv run alembic downgrade -1    # 往返成功
DATABASE_URL=<isolated> uv run alembic upgrade head
(cd frontend && pnpm run lint && pnpm run typecheck \
  && pnpm exec vitest run --reporter=dot && pnpm run build)
# lint/typecheck 通过；vitest 83 files / 729 tests；build 通过
docker compose -f compose.yml config -q
docker compose -f compose.prod.yml config -q
git diff --check
```

环境说明（本机 Windows 执行，未影响结论有效性）：

- `mypy app` 的改动文件全部通过；全仓存在 7 个与本次无关的 Windows-only 既有错误（`app/services/files/parsers.py`、`scanner.py` 的 `resource`/`AF_UNIX` Unix-only API），Linux CI 不受影响。
- 全量 pytest 使用官方 PostgreSQL 16.9 免安装二进制（`initdb` 用户态实例，验证后停止），`PYTHONUTF8=1` 解决测试 fixture 的 GBK 默认编码问题（Linux 不存在）。
- `.env` 当前 `OPENAI_VISION_MODELS=glm-5.3-flash,kimi-k3` 不在 `OPENAI_MODELS` 内，Settings 校验直接失败（与本次改动无关的既有状态）；测试进程用 `OPENAI_VISION_MODELS=""` 覆盖，未修改 `.env`。**建议清掉该行**：GLM 视觉应通过模型目录（`supports_image_input`）配置，不再使用旧 OPENAI 视觉白名单。

真实上游 smoke（GLM API key 来自 `.env`，全部通过）：

| # | 场景 | 证据 |
| --- | --- | --- |
| 1 | `glm-5.3` 文本 + raw thinking（effort=high） | `reasoning_delta(kind=raw)` 先于正文；5358 字符思考流；`finish=stop`；usage 含 `reasoning_tokens: 2252` |
| 2 | effort 档位透传 | `high` / `low` 均成功；简单事实题 `reasoning_tokens: 0`（模型自行跳过，见观察） |
| 3 | 工具续接 | round 1 组装 `get_weather` 工具调用（参数正确）；round 2 上游接受回放的 assistant 消息并给出最终回答 |
| 3b | 非空 `reasoning_content` 回放（数学推理 + 工具） | round 1 产生 249 字符思考与工具调用；round 2 带回放成功（541 字符回答） |
| 4 | 无工具保留思考回放 | 历史 `ReasoningBlock` + 正文回放被接受，正常回答 |
| 6 | `glm-5.3-flash` 图片输入 | `image_url`（data URL）+ `detail: "high"` 被接受，正确识别纯红图片，`reasoning_tokens: 165` |

9.4 结论（D3）：`stream_options` 与 `detail` 均被真实上游接受，无 fallback 需要；第 7 节现状锁定断言保持原样。

跨路由历史投影（矩阵 case 5）为 provider 无关逻辑，由现有 history 单测覆盖（GLM 亲和 key `(adapter, upstream, base_url, provider_model)` 与其他适配器同机制）；本次未重复搭建多 Run 全栈场景。

视觉边界：本次 smoke 验证了 wire 层（data URL + detail）被上游接受；生产启用 `supports_image_input` 前仍需在部署环境用真实 R2 preview 签名 URL 走一次完整图片链路 smoke（依赖 `FILES_PREVIEW_LLM_*` 凭据）。

## 观察与已知限制

- GLM-5.3 对简单任务即使 `effort=high` 也可能返回 0 思考 token（`thinking.type=enabled` 是"强制开启"，不代表每题必产出 CoT）。目录 `thinking_levels` 仍须非空：`glm-5.3` 系只配 `low,high,max`，`glm-5.2` 全档位（上游自动映射 `low/medium→high`、`xhigh→max`）。
- `request_id` 在 GLM 响应体中而非 `x-request-id` header，`StreamDone.provider_request_id` 目前为 `None`（不影响业务；如需追踪可后续从 body 提取）。
- usage 富含 `completion_tokens_details.reasoning_tokens` 与 `prompt_tokens_details.cached_tokens`，原样进 `runs` usage 元数据。
- `clear_thinking=false` 恒定生效（Preserved Thinking），成本由路由亲和投影限定；观察期关注同阶段长对话的上下文增长。

## 运营配置示例

```bash
docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-upstream \
  --key glm --label "GLM Official" --adapter glm \
  --base-url https://open.bigmodel.cn/api/paas/v4 --set-api-key --enabled

docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-model \
  --key glm-5.3 --label "GLM 5.3" \
  --thinking-levels low,high,max --token-profile default \
  --sort-order 20 --enabled

docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-route \
  --model glm-5.3 --upstream glm --upstream-model glm-5.3 \
  --priority 20 --reasoning-outputs raw --enabled
```

视觉模型（部署环境完成完整链路 smoke 后再启用）：

```bash
docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-model \
  --key glm-5.3-flash --label "GLM 5.3 Flash" \
  --thinking-levels low,high,max --token-profile default \
  --vision --image-token-reserve 8192 --sort-order 21 --enabled
```

## 发布与回滚

按计划第 10 节执行：迁移 expand-only；上线时 `force-recreate api` 与全部 `worker`；目录配置热生效，无重启。回滚：disable GLM 路由/模型即可热回滚；代码回滚无数据依赖；如需 downgrade 迁移，迁移自身在存在 GLM 上游行时拒绝。
