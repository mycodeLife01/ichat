# 数据库聊天模型目录

## 结果

用户可选聊天模型不再绑定单个 provider model id。PostgreSQL 分别保存聊天模型、模型上游和模型路由；同一聊天模型可同时拥有 DeepSeek 官方、OpenRouter 等多条上游路径。模型、路由、endpoint、上游 model id、优先级、启停状态和 API key 在事务提交后对新请求立即生效，不需要重启 API 或 Worker。

管理入口是 React SPA 的 `/model-admin` 独立控制台与 `/api/v1/model-admin/*` API，operator CLI 继续作为应急入口。当前仍不增加管理员账户或角色：管理 API 不接受普通用户 JWT，只校验部署级固定密钥 `MODEL_ADMIN_ACCESS_KEY`；浏览器通过 `X-Model-Admin-Key` 发送，密钥只保留在当前标签页 sessionStorage，显式锁定、401 或 429 后清除。上游 API key 只在保存时提交，列表只返回末四位 hint。

## Web 管理与安全边界

- `GET /api/v1/model-admin` 返回模型、上游、路由、数据库目录开关及后端选出的首选路由，不返回管理密钥、上游明文 key 或数据库密文。
- `PUT /models/{key}`、`PUT /upstreams/{key}` 与 `PUT /routes` 负责幂等新增/编辑；模型和上游 key、既有路由三元组作为稳定身份不可原地改名。
- `PATCH */enabled` 完成快速上线/下线；`PATCH /catalog` 原子切换 ENV/数据库目录；`POST /import-env` 幂等导入现有 ENV，默认不自动激活。
- 固定密钥使用常量时间比较。错误尝试按真实来源 IP 在 Redis 记录 15 分钟失败预算；前 10 次统一返回 401，之后返回带 `Retry-After` 的 429。Redis 故障时仍拒绝错误密钥，正确密钥不依赖 Redis 可用性。
- 密钥至少 32 字符，建议 `openssl rand -hex 32`。它不进入 PostgreSQL、URL、日志或 Cloudflare Pages 构建变量；Compose 只向 API 分发，并在 LLM Worker、Celery Worker、媒体 Worker 与 Beat 中显式清空。
- 固定密钥轮换属于部署配置变更，需要 force-recreate API；模型、上游凭据和路由的日常变更只写 PostgreSQL，不重启任何服务。

## 数据与运行语义

- `chat_models`：稳定逻辑 key、展示名、排序、thinking levels、图像能力和 token 估算 profile。
- `model_upstreams`：稳定 key、endpoint、`deepseek|openai|openrouter` 适配器和 Fernet 加密 API key；状态只显示末四位 hint。
- `model_routes`：聊天模型、模型上游、该上游 model id、优先级、启停状态和
  `reasoning_outputs`（`raw` / `summary`）。优先级数值越小越先选。
- `model_catalog_state`：单行开关。关闭时继续使用旧 ENV 目录；迁移默认关闭。
- `runs.model_config_snapshot`：创建 Run 时固化 adapter、endpoint、上游 model id、模型能力和
  路由级推理输出能力，不含凭据；v2 是当前格式，Worker 仍兼容 v1。
- `run_provider_messages.blocks`：一次 Run 中每次模型调用与工具交互的完整 transcript；
  `ReasoningBlock` 区分 raw/summary，`ProviderContinuationBlock` 保存仅供所属适配器续传的不透明状态。
- `run_drafts`：活跃 Run 的正文、raw 与 summary 累计检查点。
- `messages.reasoning` / `messages.reasoning_summary`：成功 Run 全部 raw/summary block 的有序聚合；
  它们是读取投影，不替代 transcript。

新 Run 每次直接查询数据库，不使用目录缓存。已经排队的 Run 按快照执行，不会因后续上下线或优先级修改悄悄换供应商；它按上游稳定 key 读取当前密文，因此同一上游的 API key 轮换可立即生效。一次 Run 内不做跨上游自动 failover，故障切换由 operator 启用低优先级备用路由或停用当前路由完成，影响随后创建的 Run。

上游稳定 key 应代表同一调用入口。只轮换该入口的 API key 可以原地更新；若要更换 adapter、endpoint 或账号归属，优先创建一个新的上游并切换路由。否则，更新前已经排队的 Run 会继续使用快照中的旧 adapter/endpoint，却读取该 key 的新凭据，可能因凭据与入口不匹配而失败。确需原地改 endpoint 时，应先排空 queued Run。

后端提交接口会实时复核模型，所以已下线模型即使仍显示在旧页面中也不能创建新 Run。React SPA 当前只在启动时获取 capabilities；已打开的标签页需要刷新才能看到新增模型或更新后的展示信息。

Web 与 CLI 都不提供 hard delete。下线使用 disable，避免删除仍被排队 Run 快照引用的上游；数据库外直接删除上游可能使旧 Run 无法恢复凭据。

## Provider 差异

数据库只选择代码适配器，不接受任意 JSON wire 参数：

| 适配器 | 可配置推理输出 | 关键行为 |
|---|---|---|
| `deepseek` | `raw` | `thinking` 与 `reasoning_effort` 扩展；`reasoning_content` 固定归类为 raw 并在工具续接历史中回放；未注册 tools 时剥离旧 tool 历史；图像按标准 `image_url` 编码，是否接收由聊天模型的视觉声明决定 |
| `openai` | 无 | reasoning model 使用顶层 `reasoning_effort`；同步生成使用 `max_completion_tokens` 且不固定 temperature；当前 Chat Completions 路径不声明可见推理输出，也不回放 reasoning 字段 |
| `openrouter` | `raw`, `summary` | reasoning 使用 `reasoning: {effort}`；同步生成使用 `max_tokens`；结构化 `reasoning.summary` → summary，`reasoning.text` 默认 → raw，但 `format=google-gemini-v1` → summary；实际返回的 typed detail 全部保存，并完整保存/回放 `reasoning_details`；无结构化 detail 时按路由契约分类 plaintext reasoning |

推理控制与推理输出相互独立：聊天模型的 `thinking_levels` 只决定用户能否调节强度，路由的
`reasoning_outputs` 只声明该上游可能返回的可见类型。Adapter 根据协议做实际分类，前端不得按
provider 名称推测。

`reasoning_outputs` 是路由能力声明，不是 transcript 过滤器。对于结构化输出，Adapter 结合网关类型与明确的底层 format 语义归类并完整保存，即使管理员的能力声明较保守；能力声明主要用于客户端展示和无类型 plaintext reasoning 的分类。不能依据标题、文字长短或文风推断类型。OpenRouter 会把 Gemini 的 thought summary 编码成 `reasoning.text`，因此 `google-gemini-v1` 必须按 summary 归类，Gemini 路由也只应声明 `summary`。这样既避免配置漂移造成内容丢失，也不会把 Gemini 未公开的内部完整 thoughts 误称为 raw。

迁移 `20260830_0020` 修正升级前已经产生的这类数据：保持 OpenRouter 原始
`reasoning_details` 不变，把关联 transcript 的中立 ReasoningBlock、仍存在的 Run 事件和成功消息
读取投影从 raw 改为 summary，并将已声明 raw 的 OpenRouter Gemini 路由收敛为 summary。迁移只以
`format=google-gemini-v1` 的结构化事实为依据，不扫描 Markdown 标题或自然语言内容。

OpenRouter 某些模型要求在工具调用续接时原样、按顺序回传不透明 `reasoning_details`。当前实现把
整组 detail 保存为 `ProviderContinuationBlock(owner="openrouter", codec="reasoning_details.v2")`，
随 assistant transcript 一起持久化；v2 payload 还带规范化 endpoint + provider model 的 replay
key，只在匹配请求中恢复为 wire `reasoning_details`。存量 `reasoning_details.v1` 保持可读，但由
历史层的 Provider 续传阶段约束保护，不能仅因下一次仍使用 OpenRouter Adapter 就回放。该 payload
不进入用户消息 API、Run SSE、公开分享、模型管理响应或日志。

历史层以 `(adapter, upstream, 规范化 base_url, provider_model)` 判定当前连续成功阶段。阶段内
完整保留 reasoning、continuation、tool call/result；阶段外的成功 Run 只投影精确用户输入（含
附件）与最终助手正文。失败/取消 Run 仍只保留精确用户输入且不形成切换屏障；Grok → Gemini →
Grok 会形成三个阶段，第二次 Grok 不复活第一次 Grok 的加密状态，只有随后连续 Grok Run 才能
续用新状态。DeepSeek 官方与 OpenRouter DeepSeek 也属于不同阶段。完整决策见 ADR 0013。
上线新模型前仍必须用真实上游跑 reasoning + tool continuation smoke，不能只因它“兼容
OpenAI”就直接启用。参考 [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[DeepSeek chat completion](https://api-docs.deepseek.com/api/create-chat-completion/)、[OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) 和 [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)。

一次 Run 若经过多次模型调用，transcript 会按顺序保存每段 raw/summary、工具调用与结果。成功
终态才把所有 raw 段以双换行聚合到 `messages.reasoning`，把所有 summary 段聚合到
`messages.reasoning_summary`；失败或取消不物化 assistant message，但保留已产生的 partial
transcript。前端默认 summary 优先、raw fallback，正文开始后也不丢弃 thinking surface。

视觉能力属于聊天模型，且只由模型自身声明：`chat_models.supports_image_input` 是唯一事实来源，适配器不持有任何视觉能力判定。同一适配器下既有支持视觉的模型（例如 `deepseek-v4-flash-vision-exp`）也有纯文本模型，因此「DeepSeek 不能收图」不再是适配器级约束。声明视觉能力时必须配置正数 `image_token_reserve` 和现有 preview 凭据。任何路由在启用前仍需对实际远端模型做图片 smoke；`deepseek` 之外的适配器同样不能只凭「兼容 OpenAI」就假定支持视觉。LLM Worker 启动时会读取当前生效目录：数据库目录包含视觉模型时，即使旧 `OPENAI_VISION_MODELS` 已清空，也必须具备 `FILES_PREVIEW_LLM_ACCESS_KEY_ID` 与 `FILES_PREVIEW_LLM_SECRET_ACCESS_KEY`。这两项属于对象存储基础设施，不能随 provider API key 和旧模型列表一起删除。运行中若配置异常，resolver 会在访问 R2 前以内部分类 `preview_signer_unconfigured` 失败，不再使用占位凭据发送无效请求。

对话标题是独立的内部 Celery workload，仍由 `SUMMARY_PROVIDER_NAME` / `SUMMARY_MODEL` 与旧 provider ENV 配置；本目录只管理用户可选的流式聊天模型。

## 首次上线

1. 生成两个职责不同的部署级密钥并写入 secret store 或 `.env`。不要把输出提交到 Git：

   ```bash
   uv run python -m app.model_admin generate-key
   openssl rand -hex 32
   ```

   第一项写入 `MODEL_CATALOG_ENCRYPTION_KEY`，同时分发给 API 和 LLM Worker；第二项写入 `MODEL_ADMIN_ACCESS_KEY`，只由 API 使用。首次分发需要重建对应进程，之后模型变更不再修改 ENV。视觉路由还依赖既有 preview bucket 及 API/LLM 两组独立读取凭据；这些是静态存储配置，不会迁入模型目录。当前版本没有在线加密密钥轮换流程，必须备份并保持 `MODEL_CATALOG_ENCRYPTION_KEY` 稳定；管理密钥可轮换，但轮换后需要 force-recreate API，并会使所有已解锁标签页失效。

2. 部署代码并执行迁移。迁移新增模型目录表、路由推理能力及 raw/summary 投影列，并保持 ENV
   目录生效；现有 DeepSeek 路由回填 `raw`，其他路由保守保持空集：

   ```bash
   docker compose -f compose.prod.yml run --rm migrate
   ```

3. 打开前端 `/model-admin`，输入固定密钥，点击“导入 ENV”并检查模型、上游和路由轨道。导入幂等，但会用当前 ENV 凭据更新对应上游。若 Web 不可用，可使用 CLI：

   ```bash
   docker compose -f compose.prod.yml exec api python -m app.model_admin import-env
   docker compose -f compose.prod.yml exec api python -m app.model_admin status
   ```

4. 在 Web 中以 disabled 创建并检查备用路由，逐项上线后点击“启用数据库目录”。激活会校验至少有一条可用路由、所有启用路由的上游凭据可解密，以及 API 进程具备视觉 preview 配置。Compose 按安全边界拆分 API 与 LLM Worker 凭据，所以激活后仍必须分别完成 API 图片接纳与 Worker 签名 smoke。若需要应急 CLI：

   ```bash
   docker compose -f compose.prod.yml exec api python -m app.model_admin activate
   ```

5. 请求 `/api/v1/capabilities`，确认模型逻辑 id、排序、thinking levels、reasoning outputs 与图像
   能力；分别发送文本、raw/summary reasoning、tool continuation 和已批准视觉 smoke。检查
   transcript 保留全部模型调用，且最终消息聚合完整。旧 ENV 保留到观察期结束，以便即时回滚。

## 常用热更新

日常操作优先使用 `/model-admin`：添加模型或上游后保持下线，添加路由并确认 adapter、远端 model id 和优先级，再依次上线上游、路由、模型。路由轨道用“当前路由”标出数据库目录真正选择的路径；数据库目录尚未激活时显示为“目录首选”。任何保存或开关操作都在单个事务提交后刷新完整目录。

以下 CLI 与 Web 调用同一组模型目录 service，只更新 PostgreSQL，适合页面不可用时应急：

```bash
# 新增或更新 OpenRouter；API key 在 TTY 中无回显输入
docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-upstream \
  --key openrouter --label OpenRouter --adapter openrouter \
  --base-url https://openrouter.ai/api/v1 --set-api-key --enabled

# 新增或编辑逻辑模型
docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-model \
  --key deepseek-v4 --label "DeepSeek V4" \
  --thinking-levels low,high,max --token-profile deepseek \
  --sort-order 10 --enabled

# 为同一模型增加 OpenRouter 路由；10 会优先于数值更大的官方路由
docker compose -f compose.prod.yml exec api python -m app.model_admin upsert-route \
  --model deepseek-v4 --upstream openrouter \
  --upstream-model deepseek/deepseek-chat --priority 10 \
  --reasoning-outputs raw,summary --enabled

# 上下线模型或具体路由
docker compose -f compose.prod.yml exec api python -m app.model_admin set-model \
  --key deepseek-v4 --disabled
docker compose -f compose.prod.yml exec api python -m app.model_admin set-route \
  --model deepseek-v4 --upstream openrouter \
  --upstream-model deepseek/deepseek-chat --disabled

docker compose -f compose.prod.yml exec api python -m app.model_admin status
```

启用备用路由时可先把它设为 enabled 且保持较大 priority，按该远端模型的真实响应配置
`--reasoning-outputs`，smoke 后再用 `upsert-route` 调小 priority；每个 CLI 命令自身是一个事务。
切换完成后，`/capabilities` 的 `id` 仍是逻辑模型 key，`provider` 字段只反映当前适配器类型，
不暴露内部上游 key。

## 回滚

目录级回滚不需要重启：在 Web 顶部点击“切回 ENV 目录”并确认即可。页面不可用时执行：

```bash
docker compose -f compose.prod.yml exec api python -m app.model_admin deactivate
```

之后新请求立即回到旧 ENV 目录；已创建 Run 仍按各自持久化配置执行。不要在观察期内删除旧 ENV 凭据。代码回滚前先执行 `deactivate` 并等待新版本创建的 queued Run 排空；数据库迁移可保持 expand 状态，不需要立即 downgrade。

## 验证

本次已完成：

```bash
uv run ruff check .
uv run mypy app
DATABASE_URL=<isolated-db> uv run alembic upgrade head
DATABASE_URL=<isolated-db> FILE_MAINTENANCE_TEST_DATABASE_URL=<isolated-db> \
  uv run pytest -q --ignore=tests/services/agents/test_prompts.py
(cd frontend && pnpm run lint && pnpm run typecheck && pnpm exec vitest run --reporter=dot && pnpm run build)
docker compose -f compose.yml config -q
docker compose -f compose.prod.yml config -q
git diff --check
```

结果：ruff 通过；mypy 检查 140 个源文件通过；两份 Compose 与 `git diff --check` 通过。空 PostgreSQL 从第一个 revision 完整升级到 `20260830_0019`，验证了 `reasoning_outputs` 数据库约束及 `0019 → 0018 → 0019` downgrade/upgrade 往返；模型目录真实事务与文件维护隔离测试 22 个通过。隔离数据库中的后端套件 701 个测试通过；最终 typed reasoning 调整后的相关回归 113 个通过。前端 76 个测试文件、646 个测试通过，lint、typecheck 和生产构建通过。

使用真实 Chromium 和当前本地目录检查了 1440 × 900 与 390 × 844 的固定密钥入口、错误密钥反馈、密集目录、DeepSeek/OpenRouter 路由能力编辑器、Escape 关闭、锁定清除与响应式布局；移动端 `scrollWidth == clientWidth == 390`，控制台无应用错误。检查过程未提交保存、上下线或目录切换。

全仓原样执行另有一个与本功能无关的既有失败：`app/services/agents/base_system_prompt.md` 使用产品名 `Piko`，但 `tests/services/agents/test_prompts.py` 仍断言 `iChat`。此外，直接使用已有开发数据库会让文件维护测试统计到其中 11 条真实待回填记录；改用空隔离数据库后相关测试全部通过。本次没有修改品牌选择，也没有清理开发数据。

自动测试不代替真实供应商 smoke。上线前仍需使用目标模型分别验证 DeepSeek raw reasoning、OpenRouter raw/summary 及 `reasoning_details` 多轮 tool continuation，以及所启用 OpenAI-compatible endpoint 的实际字段行为。

Gemini format 修正另行完成：OpenRouter Adapter 相关与持久化回归 57 项通过，ruff 全仓通过，
mypy 检查 140 个源文件通过；空 PostgreSQL 从首个 revision 升级到 `20260830_0020` 成功。开发库
中的真实 `google/gemini-3.7-flash` 样本已验证为 `messages.reasoning=NULL`、
`messages.reasoning_summary` 保留完整 2042 字符，6 个 transcript 中立推理块均为 summary，而 6 个
原始 `reasoning.text/google-gemini-v1` continuation detail 保持不变。
