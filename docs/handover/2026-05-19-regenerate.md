# 实现纪录：Regenerate（edit-and-regenerate + regenerate-only）

日期：2026-05-19

## 范围

- 新增两个 POST 端点：
  - `/api/v1/conversations/{cid}/messages/{mid}/edit-and-regenerate`，body `{ "content": ... }`，把 mid 及之后所有未归档消息 archive，新 user message 追加在末尾，新 run queued。
  - `/api/v1/conversations/{cid}/messages/{mid}/regenerate`，无 body。mid 可以是 user 或 assistant；assistant 内部反查 user message 作为锚点；archive 锚点之后的所有未归档消息（不动锚点自己），复用锚点作为 user_message_id，新 run queued。
- 前端：user message 旁加「编辑」按钮（inline textarea + 保存），assistant message 旁加「重新生成」按钮，均在 activeRun 存在时禁用。
- 无 schema 迁移；worker、provider、SSE 无变更。

## 关键文件

- `app/services/conversations/service.py`：`edit_user_message_and_regenerate`、`regenerate_from_message`、`_archive_messages_at_or_after_position`、`_archive_messages_after_position`、`_get_owned_unarchived_message_for_update`。
- `app/api/v1/conversations.py`：`edit_and_regenerate_route`、`regenerate_route`。
- `tests/services/conversations/test_regenerate.py`：service 层 11 个测试。
- `tests/api/test_conversations.py`：4 个集成测试（happy edit / happy regen-assistant / cross-user 404 / active-run 409）。
- `frontend/api.js`：`conversations.editAndRegenerate`、`conversations.regenerate`。
- `frontend/views/chat.js`：`buildEditButton`、`buildRegenerateButton`、`startEditingUserMessage`、`triggerRegenerate`。

## 设计要点回顾

- 截断用 `messages.archived_at`；不删数据，留审计。
- `runs.user_message_id` 没有 unique 约束，regenerate-only 让多个 run 复用同一 user_message_id 是允许的。
- 老 run 的 `run_events` 保留；前端不再展示其 message 因为已 archive。
- active run 冲突走现有 `ensure_no_active_run`，返回 409。后端不自动 cancel。
- `materialize_assistant_message` 使用 `MAX(position) + 1`，archive 不影响 position 单调性，因此 worker 完成新 run 后写入的 assistant 自然在最高 position。
- service 测试断言 `result.run.status == "queued"` 时使用返回值（Pydantic snapshot），不再从 DB re-fetch——避免被本地运行的 worker 抢占后 status 变成 `started` 的 race。

## 验证

```bash
# 起服务（需要 postgres；worker 可选）
docker compose up -d

# Service 测试
uv run pytest tests/services/conversations/test_regenerate.py -v

# API 测试
uv run pytest tests/api/test_conversations.py -v

# 全套
uv run pytest
uv run ruff check app tests
uv run mypy app
node --test frontend/views/chat.test.js
```

> 注：项目 api 容器以 `--no-dev` 构建，不含 pytest/ruff/mypy。本地与 CI 都通过 `uv run ...` 直接在宿主机跑。

## 已知局限

- 不引入分支树；视图只见最新版本。
- regenerate 端点接受 assistant message id 时，如果该 assistant 的 `run_id` 已被某种异常清空，会返回 409；正常数据不会触发。
- 大体积归档（一次性 archive 数百条消息）目前是单条 UPDATE，未做分页或后台处理；对现在的对话规模无影响。
- 前端 inline 编辑面板会在任何 `rerenderMain()` 时被覆盖（例如同会话的 streaming 触发的状态变更）。在 active run 期间按钮已 disable，覆盖概率低，但若发生用户正在编辑过程中被打断，未提交的草稿会丢失。后续若要更稳健，可把编辑器状态搬到 `state` 里并在 rerender 中显式保留。
