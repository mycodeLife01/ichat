# GLM 上游 Provider 接入计划

日期：2026-09-21

状态：已实施（2026-09-21）。实施与验证结果见 [交接文档](../handover/2026-09-21-glm-provider.md)；第 11 节清单按实际结果勾选。

需求依据：支持 GLM API（智谱开放平台）作为流式聊天上游 Provider。

协议依据（2026-09-21 抓取的 GLM 官方文档）：

- [快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start)
- [对话补全 API 参考](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)
- [深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking) / [思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)
- [工具调用](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling) / [工具流式输出](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool)
- [模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview) / [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) / [GLM-5.3-Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)

架构依据：`docs/README.md` 路由的 [ADR 0012](../adr/0012-use-database-model-routes-and-code-adapters.md)、[ADR 0013](../adr/0013-scope-provider-continuations-by-route-affinity.md)、[模型目录交接](../handover/2026-08-29-database-model-catalog.md)、[续传亲和交接](../handover/2026-08-31-provider-continuation-route-affinity.md)。

## 0. 已定决策

- D1：遵循 ADR 0012，新增独立 `glm` 代码适配器。thinking、`clear_thinking`、强制思考、`reasoning_content` 回放是 GLM 私有协议，不得由 `openai` 适配器或数据库 wire 参数承载。
- D2：范围为数据库模型目录的流式聊天上游。旧 ENV 目录、`SUMMARY_*` 标题 provider、`resolve_provider`、旧标题链路均不改动。
- D3（用户决定，2026-09-21）：`stream_options: {"include_usage": true}` 与 `image_url.detail` 保持共享基类现有行为原样发送，本期不做预防性裁剪；由第 9 节真实 smoke 实测，若 GLM 拒绝再执行 fallback 并重跑。
- D4：`reasoning_effort` 原样透传，不做适配器级映射。GLM-5.3 / 5.3-FLASH 强制思考且仅接受 `low/high/max`：这类模型的 `thinking_levels` 必须配置为非空且档位在上游支持范围内，由 operator 在目录配置保证；适配器不做模型族推断。
- D5：`thinking.clear_thinking` 固定 `false`（Preserved Thinking，官方对 Agent 场景的推荐形态），与 `reasoning_content` 历史回放配套；回放范围已被 ADR 0013 路由亲和投影限定。smoke 后如上下文成本异常，再评估"仅注册 tools 时置 false"的细化，不作为本期目标。

## 1. 交付目标与成功标准

通过 `/model-admin` 配置 `glm` 适配器上游与路由，流式聊天 Run 全链路可用。

| 编号 | 成功标准 | 证明手段 |
| --- | --- | --- |
| S1 | 管理面接受 `glm`；`reasoning_outputs` 仅允许空集或 `["raw"]`，非法值拒绝 | 管理 service / API / 前端测试 |
| S2 | GLM 路由 Run 正常流式：`reasoning_delta(kind=raw)` 先于正文；成功后 `messages.reasoning` 聚合思考；transcript 保留完整模型调用 | 定向测试 + 真实 smoke |
| S3 | 注册 tools 的续接请求把 assistant 推理回放为 `reasoning_content` | 适配器单测断言 wire payload；真实 smoke 确认上游接受 |
| S4 | DeepSeek / OpenAI / OpenRouter 现有行为零变化 | 全量后端测试与现有适配器回归 |
| S5 | 迁移 upgrade / downgrade 往返成功 | 隔离数据库 alembic 验证 |
| S6 | `stream_options` 与 `detail` 按现状发送并被 GLM 接受；被拒则按 9.4 fallback 处理后重跑 | 真实 smoke 记录 |
| S7 | 视觉声明（可选）只在真实图片 smoke 通过后启用 | `glm-5.3-flash` 图片 Run smoke |

非目标：GLM embedding / 图像生成 / 异步接口；标题生成切 GLM；旧 ENV 目录支持；Run 内自动 failover；新增 token profile。

## 2. GLM 协议事实基线

| 主题 | 结论 |
| --- | --- |
| Endpoint 与鉴权 | `POST https://open.bigmodel.cn/api/paas/v4/chat/completions`，`Authorization: Bearer <key>`；OpenAI SDK 直接可用（`base_url=https://open.bigmodel.cn/api/paas/v4/`） |
| 流式 | `stream: true`，SSE，`data: [DONE]` 结束；`stream_options` 未记载（本期保持发送，见 D3 / S6） |
| 思考控制 | 请求体 `thinking: {type: enabled\|disabled, clear_thinking: bool}`；默认 `enabled`；GLM-5.3 / 5.3-FLASH 强制思考，`disabled` 报错 |
| 推理档位 | 顶层 `reasoning_effort`，`thinking` 开启时生效，默认 `max`；5.3 系仅 `low/high/max`；5.2 全档位并自动映射 |
| 思考输出 | 流式 `delta.reasoning_content`，同步 `message.reasoning_content`；交错思考 + 工具必须完整回传并配 `clear_thinking: false` |
| 工具 | 标准 function 协议；`tool_choice` 仅 `auto`；最多 128 个；`tool_stream: true` 才分片返回工具参数（本期不发送，共享缓冲同时兼容整块与分片） |
| 响应字段 | usage：`prompt_tokens` / `completion_tokens` / `total_tokens`；`finish_reason` 含 `stop/length/tool_calls/sensitive/network_error`；`request_id` 在响应体（非 `x-request-id` header） |
| 参数边界 | `temperature` 0–1（5.3 系默认 1.0）；`max_tokens` ≤ 131072；图片输入 `image_url.url`（URL 或 data URL），`detail` 未记载 |

现有共享基类已兼容的点：SSE 解析、工具分片/整块缓冲、`finish_reason` 字符串透传、usage dict 化、图片 `image_url` 编码。GLM 专属处理集中在 `thinking` 请求体与 `reasoning_content` 解析/回放。

## 3. 已核对实现入口

| 文件 | 变更 |
| --- | --- |
| `app/agent/providers/glm.py`（新增） | `GLMProvider(OpenAIChatCompletionsProvider)` |
| `app/agent/providers/__init__.py` | 导出 `GLMProvider` |
| `app/services/agents/registry.py` | `ProviderAdapter` Literal 与 `build_provider` 增加 `glm` 分支 |
| `app/services/model_catalog/service.py` | `_ADAPTERS`、`_ADAPTER_REASONING_OUTPUTS` 增加 `glm` |
| `app/services/model_catalog/management.py` | 同上两个常量 |
| `app/models/model_catalog.py` | `model_upstreams.adapter` CHECK 约束增加 `'glm'` |
| `alembic/versions/20260921_0025_allow_glm_adapter.py`（新增） | 重建 `adapter_valid` 约束 |
| `app/schemas/model_admin.py` | `ProviderAdapter` Literal |
| `app/model_admin.py` | CLI `--adapter` choices |
| `frontend/src/api/modelAdmin.ts` | `ModelProviderAdapter` union |
| `frontend/src/model-admin/ModelAdminEditors.tsx` | adapter 下拉、`adapterReasoningOutputs`、路由编辑默认值 |
| `frontend/src/model-admin/ModelAdminPage.test.tsx` 等 | 管理面回归 |

不需要改动：`openai_compat.py`（`stream_options` / `detail` 按 D3 保持现状）、worker executor、SSE 契约、ENV 配置、`SUMMARY_*`。

## 4. 适配器设计

`GLMProvider`（`name="glm"`，display `GLM`）：

- `capabilities = ProviderCapabilities(supports_tool_history=False, supports_reasoning=True)`：未注册 tools 时沿用基类剥工具历史保护（与 DeepSeek 同策略，防止无工具请求回放工具标记）。
- `_replay_reasoning_in_history = True`：assistant `ReasoningBlock(kind=raw)` 回放为 `reasoning_content`；ADR 0013 的路由亲和投影保证只在本阶段回放。
- `_reasoning_from_delta`：读取 `delta.reasoning_content`，产出 `ReasoningDelta(kind="raw")`。
- `_stream_request_extras`：返回 `{"extra_body": {"thinking": {"type": "enabled" | "disabled", "clear_thinking": False}}}`；`reasoning_effort` 作为顶层 typed kwarg，仅 enabled 时附带。`ReasoningConfig=None` 视为 GLM 默认（enabled + `max`），发送 `thinking: {"enabled"}` 且不带 effort。
- `_generate_request_kwargs`：`max_tokens` + `temperature: 0.3`（在 0–1 范围内）；thinking 处理同上。
- `count_tokens`：不新增 token profile，沿用基类保守估算；目录 `token_profile` 配 `default`。
- 错误映射：沿用基类，产生 `glm_http_error` / `glm_transport_error` / `glm_summarize_*`。无 opaque continuation，不需要新增错误码。
- `finish_reason`（含 `sensitive` / `network_error`）按字符串透传为 `StreamDone`，本期不做特殊分支，交接记录该语义。

GLM 不产生 `ProviderContinuationBlock`：其续传协议是明文 `reasoning_content` + 标准 `tool_calls`，历史层现有机制已覆盖。

## 5. 目录校验与数据库迁移

- `_ADAPTER_REASONING_OUTPUTS["glm"] = frozenset({"raw"})`：GLM 思考输出是明文思维链，归 `raw`；`summary` 拒绝。
- ORM 与迁移同步：`adapter_valid` 约束改为 `('deepseek', 'openai', 'openrouter', 'glm')`。
- 新迁移 `20260921_0025_allow_glm_adapter`（创建前读取实际 head，当前为 `20260905_0024`）：
  - upgrade：drop `adapter_valid`，重建含 `glm` 的同名约束。
  - downgrade：先 `SELECT count(*) FROM model_upstreams WHERE adapter='glm'`，存在则 raise 拒绝（参照 0016 fail-closed 风格），否则恢复原约束。
- 该迁移仅 expand，无数据回填。旧版本代码不识别 `glm` 时目录校验会拒绝新上游，因此必须先部署后配置（见第 10 节）。

## 6. 管理面

- 后端 schema / CLI / service 常量如第 3 节；`import-env` 不涉及 GLM，不改动。
- 前端：adapter 下拉加 `glm`；`adapterReasoningOutputs.glm = ["raw"]`；路由编辑器选中 glm 上游时默认推理输出 `["raw"]`。
- 运营配置指引（写入交接）：
  - `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx`：`thinking_levels` 必须非空且取 `low,high,max`（D4）。
  - `glm-5.2`：可用更宽档位，但 `low/medium` 上游映射为 `high`，按需配置。
  - 视觉：仅 `glm-5.3-flash` 系声明 `supports_image_input`，并配置正数 `image_token_reserve`；启用前提是预览凭据齐备且第 9 节图片 smoke 通过。

## 7. 测试计划

新增 `tests/agent/test_glm_adapter.py`（形态对照 `test_deepseek_adapter.py`）：

- thinking 请求体：enabled + effort 透传；disabled 不带 effort；`clear_thinking=false` 恒定；`ReasoningConfig=None` 默认 enabled。
- `reasoning_content` delta → `ReasoningDelta(kind="raw")`，且先于 text delta。
- 工具续接：注册 tools 时 wire 保留 `reasoning_content` + `tool_calls`；未注册时剥离。
- D3 现状锁定断言：create kwargs 仍包含 `stream_options: {"include_usage": true}`；图片 content part 仍带 `detail: "high"`。若后续执行 fallback，这两条断言随之反转，防止无声回退。
- 图片输入走基类编码（对照 DeepSeek image 测试）；HTTP 错误映射 `glm_http_error`；generate 正常 / 空内容 / 错误分支；capabilities 与 count_tokens。

目录与管理面：

- `tests/services/model_catalog/`：`glm` raw 接受、`summary` 拒绝、快照 v2 往返、未知 adapter 拒绝、token profile `default`。
- `tests/api/test_model_admin.py`：upsert upstream `adapter=glm` 成功；非法 adapter 拒绝；reasoning_outputs 校验。
- 迁移：隔离库 `upgrade head`、`downgrade -1`、再 `upgrade head`。

## 8. 验证命令

```bash
uv run ruff check .
uv run mypy app
uv run pytest -q tests/agent tests/services/model_catalog tests/api/test_model_admin.py tests/worker
DATABASE_URL=<isolated-pg> uv run alembic upgrade head
DATABASE_URL=<isolated-pg> uv run alembic downgrade -1
DATABASE_URL=<isolated-pg> uv run alembic upgrade head
uv run pytest -q
```

前端：

```bash
(cd frontend && pnpm run lint && pnpm run typecheck && pnpm exec vitest run --reporter=dot && pnpm run build)
```

其他质量门：

```bash
docker compose -f compose.yml config -q
docker compose -f compose.prod.yml config -q
git diff --check
```

## 9. 真实上游 smoke 矩阵

前置：具备 GLM API key；流式 Worker 运行包含适配器的版本；web search 凭据按需。全部用真实上游，不用 mock 替代验收。

| # | 场景 | 模型 | 通过条件 |
| --- | --- | --- | --- |
| 1 | 文本 + raw thinking | `glm-5.3` | SSE 先 `reasoning_delta(kind=raw)` 后正文；Run 成功；`messages.reasoning` 非空 |
| 2 | effort 档位 | `glm-5.3` | `low` 与 `max` 各一次均成功（验证 D4 透传） |
| 3 | 工具续接 | `glm-5.3` + web search | ≥2 次模型调用、`tool_call` 事件、最终成功；上游接受 `reasoning_content` 回放 |
| 4 | 同路由连续 Run | `glm-5.3` ×2 | 第二 Run 成功（Preserved Thinking 回放被接受，无跨阶段泄漏） |
| 5 | 跨路由切换 | GLM → DeepSeek → GLM | 切换后历史折叠为可移植 turn；回到 GLM 开始新阶段；transcript 不变 |
| 6 | 视觉（可选） | `glm-5.3-flash` | 图片 Run 成功；失败按 9.4 处理，未通过不得声明视觉 |

9.4 `stream_options` / `detail` 验证与 fallback（D3）：

- 观察 case 1/2：若 GLM 对 `stream_options` 返回 4xx（错误体明确指向未知参数），fallback = 为共享基类增加"按适配器关闭 `stream_options`"的钩子，仅 `glm` 关闭，重跑 case 1–4；usage 缺失记录为已知限制（不影响 Run 事实）。
- 若 `stream_options` 被静默忽略：保留发送（与 DeepSeek 行为一致），并在交接记录 usage 是否出现在最终 chunk。
- case 6 若错误体指向 `detail` / image 字段：fallback = GLM 子类在输出 wire 时剥离 image part 的 `detail`，重跑；通过后才允许启用 `supports_image_input`。
- 两条结论必须写回交接文档；fallback 实施后第 7 节对应断言同步反转。

2026-09-21 实测结论：`stream_options` 与 `detail` 均被真实上游接受，未执行任何 fallback；第 7 节现状锁定断言保持原样。证据见交接文档。

记录项：每次 smoke 的模型、effort、HTTP 状态、错误体摘要（不含 API key）、SSE reasoning/text 顺序、`runs.usage`、`finish_reason`。

## 10. 发布、回滚与交接

发布顺序：

1. 合并前完成第 8 节全部质量门。
2. 部署后端并执行迁移（expand-only，向后兼容）；`force-recreate api` 与全部 `worker`（适配器与校验代码同时存在于两端）。
3. 部署前端。
4. `/model-admin`（或 CLI）按 disabled 顺序创建：glm 上游 → 逻辑模型 → 路由；逐级执行第 9 节 smoke 后逐级启用。
5. 观察期保留 DeepSeek / OpenAI / OpenRouter 路由不动。

回滚：

- 运行期：disable GLM 路由/模型即可热回滚；数据库目录可整体切回 ENV。
- 代码回滚无数据依赖；若必须 downgrade 迁移，先确认 `model_upstreams` 无 `adapter='glm'` 行（迁移自身 fail-closed）。

交接：完成后新增 `docs/handover/2026-09-21-glm-provider.md`，链接本计划，记录 smoke 证据、`stream_options` / `detail` 结论、运营配置（thinking_levels 档位表）；更新 `docs/README.md` 路由表；第 11 节清单按实际结果勾选。

## 11. 实施清单

2026-09-21 已执行，结果见[交接](../handover/2026-09-21-glm-provider.md)。

- [x] A 适配器：`glm.py` + registry / export + 单测（tests/agent 95 passed，含 13 项 GLM 专项）
- [x] B 目录校验：service / management 常量 + ORM 约束 + 迁移与往返验证（隔离库 upgrade → downgrade → upgrade 通过；model_catalog 16 passed）
- [x] C 管理面：schema / CLI + API 测试（6 passed）+ 前端类型 / 编辑器
- [x] D 质量门：全量 pytest 798 passed；ruff 通过；mypy 改动文件通过（7 个既有 Windows-only 错误与本次无关）；前端 lint / typecheck / vitest 729 / build 通过；compose config ×2、git diff --check 通过
- [x] E 真实 smoke：矩阵 1/2/3/3b/4/6 通过；9.4 结论回写（无 fallback）
- [x] F 交接：handover + README 更新

## 12. 实施调整

- 矩阵 case 5（跨路由历史投影）为 provider 无关逻辑，由既有 history 单测覆盖，未重复搭建多 Run 全栈场景；已记录在交接。
- 视觉 smoke 在 wire 层用 data URL 验证（含 `detail`）；生产启用 `supports_image_input` 前仍需 R2 preview 签名 URL 的完整链路 smoke，依赖 `FILES_PREVIEW_LLM_*` 凭据。
- 目录测试补充 `set_database_catalog_enabled`：fixture 默认 ENV 目录，`available_chat_models` 断言需先启用数据库目录。
- 本机验证环境：Docker Desktop 因损坏的 `%LOCALAPPDATA%\Docker\run\dockerInference` reparse point 无法启动（需管理员删除，与仓库无关）；改用官方 PostgreSQL 16.9 免安装二进制的用户态实例完成全部数据库验证。全量 pytest 另需 `PYTHONUTF8=1`（Windows GBK 默认编码读取 UTF-8 fixture）与 `OPENAI_VISION_MODELS=""` 覆盖（`.env` 中该白名单与 `OPENAI_MODELS` 子集校验冲突的既有状态）。
