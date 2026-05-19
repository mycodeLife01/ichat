# 2026-05-20 草稿对话与自动标题交接

## 本次完成

- 新增 `conversations.activated_at`，Alembic 迁移会把旧 conversation 回填为 `created_at`，避免历史对话被列表过滤隐藏。
- Conversation 列表只返回已激活对话；详情、rename、delete、send、edit-and-regenerate、regenerate 仍允许 owner 操作草稿。
- Worker 成功物化 assistant message 时，在同一事务内激活 conversation。
- Provider ABC 新增非流式 `summarize()`；DeepSeek adapter 支持标题生成用的非流式 chat completion 调用。
- Worker 在 run 成功事务提交后 best-effort 生成标题，失败只记录日志，不影响 run terminal event 和 assistant message。
- 前端新建对话不进入侧栏；`selectedId` 和 `draftConversationId` 写入 localStorage；run 成功后刷新列表和详情，清理 draft 标记；若标题尚未写回，对应侧栏会话行显示闪烁骨架条，并在标题生成后刷新侧栏。

## 关键文件

- `alembic/versions/20260519_0002_add_conversation_activation.py`
- `app/models/conversation.py`
- `app/schemas/conversations.py`
- `app/services/conversations/service.py`
- `app/providers/types.py`
- `app/providers/deepseek.py`
- `app/worker/title.py`
- `app/worker/executor.py`
- `frontend/state.js`
- `frontend/auth.js`
- `frontend/styles.css`
- `frontend/views/chat.js`

## 行为说明

- `POST /api/v1/conversations` 返回 `activated_at: null`，但新建草稿不会出现在 `GET /api/v1/conversations`。
- `GET /api/v1/conversations` 过滤 `activated_at IS NOT NULL`。
- `GET /api/v1/conversations/{id}` 不过滤 `activated_at`，owner 可以刷新后重新打开草稿并恢复 streaming。
- `PATCH /api/v1/conversations/{id}` 不激活草稿；草稿重命名后仍隐藏。
- cancel / failed run 不激活 conversation，也不会物化 assistant message。
- 标题生成只在首个 succeeded run 且 `title IS NULL` 时尝试一次；写回 SQL 也带 `title IS NULL` guard，避免覆盖用户手动标题。

## 验证

本次本地 PostgreSQL 通过 `docker compose up -d postgres` 启动，并已升级到 head。

```bash
uv run pytest tests/db/test_alembic.py tests/db/test_session.py tests/core/test_config.py tests/schemas/test_conversation_schemas.py tests/services/conversations/test_service.py tests/services/conversations/test_materialize.py tests/providers/test_fake.py tests/providers/test_deepseek_adapter.py tests/worker/test_auto_title.py tests/worker/test_executor.py tests/worker/test_executor_batching.py tests/worker/test_concurrency.py tests/api/test_conversations.py -v
# 74 passed

uv run pytest
# 191 passed, 1 warning

uv run ruff check app tests
# All checks passed

uv run mypy app
# Success: no issues found in 48 source files

node --test frontend/views/chat.test.js
# 30 passed

docker compose config
# OK

uv run env DATABASE_URL=postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat SUMMARY_MODEL=deepseek-chat alembic upgrade head
# OK, already at head after applying 20260519_0002
```

## 注意事项

- `SUMMARY_MODEL` 是必填配置；`.env.example` 已新增默认值。已有本地或生产 `.env` 需要同步补上 `SUMMARY_MODEL=deepseek-chat` 或目标 summary model。
- 标题生成在 run 成功事务提交后执行，不新增 SSE title event。前端在 `run_succeeded` 后主动重拉列表和详情；如果首次重拉时标题尚未写回，先标记该 conversation 为 title pending，再刷新列表，避免短暂显示“新对话”。
- title pending 期间侧栏对应会话行显示灰色圆角闪烁骨架条；如果标题生成失败，或轮询窗口内仍未写回，清理 pending 状态并回退显示“新对话”占位。
- 不做草稿 GC、不重试标题生成、不新增 run event type。
