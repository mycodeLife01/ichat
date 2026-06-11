# 实现纪录：每次请求可配置的 Thinking 模式（provider_options）

日期：2026-06-11

## 范围

原先 DeepSeek 思考模式（`thinking` 开关与 `reasoning_effort`）由 env 配置全局写死。本次改为每个发送请求可独立配置：

- 后端：`runs` 表新增 `provider_options` JSONB 列；三个产生 run 的端点（send / edit-and-regenerate / regenerate）请求体接受可选的 `thinking_enabled` 与 `reasoning_effort`，API 在创建 run 时把「请求值 ?? env 默认值」解析定型并持久化到 run 上；worker 执行时从 run 行读回选项透传给 provider。
- 前端：Composer 中原 "Fast" 占位按钮改为向上弹出的「智能水平」dropdown，三档 **Fast / High / Max**——Fast 即关闭 thinking，High / Max 对应 DeepSeek 的两档 `reasoning_effort`。档位持久化在 localStorage（key `ichat.thinkingLevel`），发送、编辑重发、重新生成均沿用当前档位（即 regenerate 用的是用户当前选择，不是原 run 的设置——这是有意的产品语义，方便"换成深度思考再答一次"）。
- env 中 `DEEPSEEK_THINKING_ENABLED` / `DEEPSEEK_REASONING_EFFORT` 保留，降级为「请求未指定时的默认值」，老客户端（不带新字段）行为不变。

## 关键文件

后端：

- `alembic/versions/20260611_0004_add_run_provider_options.py`：新增 `runs.provider_options` JSONB（nullable，老行为 NULL）。
- `app/models/run.py`：`Run.provider_options` 字段。
- `app/schemas/conversations.py`：`RunOptionsRequest`（`thinking_enabled: bool | None`、`reasoning_effort: Literal[...] | None`）；`MessageCreateRequest` 继承之。
- `app/api/v1/conversations.py`：`resolve_provider_options()` 解析默认值；regenerate 路由新增可选 body（`RunOptionsRequest | None = None`，无 body 的老调用仍合法）。
- `app/services/conversations/service.py`：三个 run 创建函数新增 `provider_options` 参数（默认 None）写入 run。
- `app/providers/types.py`：新增 frozen dataclass `ThinkingOptions(enabled, reasoning_effort)`；`Provider.stream()` 签名新增 `thinking: ThinkingOptions | None = None`。
- `app/providers/deepseek.py`：`stream()` 用入参构造 payload；`thinking=None` 时回落 env 默认（兼容存量 NULL 行）。
- `app/worker/executor.py`：`_thinking_options_from_run()` 从 run 行还原选项（缺 key 同样回落 env），沿 `execute_run → _run_provider_stream_until_done_or_cancelled → _run_provider_stream` 透传到 `provider.stream()`。

前端：

- `frontend/src/runs/thinkingLevel.ts`：`ThinkingLevel` 三档定义、`toRunOptions()` 映射、`thinkingLevelStore`（localStorage 持久化，非法值回落 `fast`）。
- `frontend/src/ui/Composer.tsx`：dropdown 实现（`role="menu"` / `menuitemradio`，选中项打勾，点击外部与 Esc 关闭，向上弹出锚定在触发按钮）。
- `frontend/src/app/AppShell.tsx`：持有 `thinkingLevel` state，初值读 store，变更时同步写回。
- `frontend/src/api/conversations.ts`：`sendMessage` / `editAndRegenerate` / `regenerate` 接受可选 options 合入请求体；regenerate 不传 options 时维持无 body。
- `frontend/src/conversations/useSendMessage.ts`、`useRegenerate.ts`：调用时 `toRunOptions(thinkingLevelStore.read())`——在请求发出的时刻读 store，而非渲染时快照。

## 设计要点回顾

- **为什么持久化到 run 而不是只传内存参数**：API 与 worker 是两个进程，靠 PostgreSQL 队列交接。选项必须落在 `runs` 行上 worker 才能读到；同时 run 重试、孤儿恢复（lease 过期被其他 worker 认领）时行为与首次执行一致。
- **为什么选 JSONB（方案 B）而不是单独 bool 列**：未来 per-request 的模型选择、温度等 provider 选项可直接进同一列,无需再迁移。
- **解析时机在 API 创建 run 时**：env 默认值在请求被接受的瞬间定型写入。之后管理员改 env 不影响已入队的 run。
- **effort 取值校验**：schema 用 `Literal["low","medium","high","xhigh","max"]`，与 `Settings.deepseek_reasoning_effort` 的 validator 集合一致；前端只暴露 high / max 两档（加 Fast 关闭档）。非法值 422。
- **regenerate 端点的 body 是可选的**：`RunOptionsRequest | None = None`，FastAPI 对无 body 的 POST 仍然放行，保持向后兼容。
- **前端三档而非「开关 + effort 二选一」**：dropdown 必须包含 Fast（关闭）档，否则用户切到 High 后无法关回。
- **`summarize()`（自动标题）不受影响**：仍固定 `thinking: disabled`。

## 验证

```bash
# 迁移（本地宿主机跑需覆盖 DATABASE_URL 指向 localhost）
DATABASE_URL="postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat" uv run alembic upgrade head

# 后端
uv run pytest
uv run ruff check app tests
uv run mypy app

# 前端（frontend/ 内）
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
```

本次实测：后端 221 passed（`tests/core/test_config.py::test_cors_allowed_origins_defaults_to_empty_list` 失败与本次无关，系本机 `.env` 的 CORS 值泄漏进测试环境，在未改动的工作树上同样失败）；前端 252 passed，lint / typecheck / build 全绿。

新增测试覆盖：

- `tests/providers/test_deepseek_adapter.py`：per-request 覆盖 env（双向）、`thinking=None` 回落。
- `tests/worker/test_executor.py`：run 带 `provider_options` 时透传、NULL 行回落 env（经 `FakeProvider.last_thinking` 断言）。
- `tests/services/conversations/test_service.py`：`provider_options` 持久化。
- `tests/api/test_conversations.py`：默认解析落库、请求覆盖落库、非法 effort 422、regenerate 带 body。
- `frontend/src/runs/thinkingLevel.test.ts`、`ui/Composer.test.tsx`、`api/conversations.test.ts` 及相关 hook 测试。

部署说明：push 到 `main` 后 deploy workflow 会在重启服务前自动执行 `docker compose -f compose.prod.yml run --rm migrate`（即 `alembic upgrade head`），无需手动迁移。

## 已知局限

- 档位是全局的（localStorage），不区分会话；切换会话不会恢复"该会话上次用的档位"。
- run 的 `provider_options` 未回传给前端（`RunResponse` 未加字段），消息列表里看不出某条回答当时用的是哪档。需要时给 `RunResponse` 加字段即可，数据已在库里。
- DeepSeek 实际支持的 effort 档位以其 API 为准；后端 schema 放行五档（与 env validator 对齐），前端只暴露 high / max。若 DeepSeek 拒绝某档位，错误会按现有 provider 错误路径反馈（run failed）。
