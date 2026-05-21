# DeepSeek 思考模式（thinking）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepSeek 流式调用支持思考模式——发送 `reasoning_effort`、把思维链增量作为独立 run event 持久化以支持重放、把完整思维链存到 assistant 消息以支持历史回看，并在前端用可折叠面板实时/历史展示。

**Architecture:** 新增 `ReasoningDelta` provider chunk，解析 `delta.reasoning_content`；worker 用「带 channel 的批处理」把思维链落成 `reasoning_delta` run event，并在 finish 时把完整思维链写入 `messages.reasoning`；`/state` 增加 `draft_reasoning`；前端在 assistant 气泡上方渲染可折叠「思考过程」面板。

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy 2.0 async / Alembic / httpx / pytest；前端 Vanilla JS + `node:test`。

**前置说明（执行者必读）:**
- DB 相关测试连接本地 Postgres（默认 `postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat`，可用 `WORKER_TEST_DATABASE_URL` 等环境变量覆盖）。执行 DB 测试前确保 `docker compose up -d postgres` 且已 `alembic upgrade head`。
- 后端测试：`uv run pytest <路径>`；Lint：`uv run ruff check app tests`；类型：`uv run mypy app`。
- 前端测试：`node --test frontend/views/chat.test.js`。
- 约定：在当前分支直接开发（项目规则，不建 worktree）。每个 Task 末尾提交。

---

### Task 1: 配置项 `deepseek_reasoning_effort`

**Files:**
- Modify: `app/core/config.py`
- Modify: `.env.example`
- Test: `tests/core/test_config.py`

- [ ] **Step 1: 写失败测试**

在 `tests/core/test_config.py` 末尾追加：

```python
def test_reasoning_effort_defaults_to_high_and_normalizes_case(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPSEEK_REASONING_EFFORT", raising=False)
    settings = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=True,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
    )
    assert settings.deepseek_reasoning_effort == "high"

    # model_copy bypasses validators; assert case-normalization via construction instead:
    built = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=True,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
        deepseek_reasoning_effort="HIGH",
    )
    assert built.deepseek_reasoning_effort == "high"


def test_reasoning_effort_rejects_invalid_value() -> None:
    with pytest.raises(ValidationError):
        Settings(
            database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
            jwt_secret="secret",
            jwt_access_token_ttl_seconds=900,
            refresh_token_ttl_seconds=2_592_000,
            deepseek_api_key="key",
            deepseek_base_url="https://deepseek.example",
            deepseek_model="deepseek-test",
            deepseek_thinking_enabled=True,
            default_system_prompt="Be helpful.",
            run_lease_seconds=60,
            worker_poll_interval_seconds=2,
            worker_heartbeat_interval_seconds=10,
            summary_provider_name="deepseek",
            summary_model="deepseek-summary",
            log_level="info",
            deepseek_reasoning_effort="ludicrous",
        )
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/core/test_config.py::test_reasoning_effort_defaults_to_high_and_normalizes_case tests/core/test_config.py::test_reasoning_effort_rejects_invalid_value -v`
Expected: FAIL（`deepseek_reasoning_effort` 字段不存在 / 不校验）。

- [ ] **Step 3: 实现配置字段与校验器**

在 `app/core/config.py` 的 `Settings` 中，于 `deepseek_thinking_enabled` 下方新增字段：

```python
    deepseek_thinking_enabled: bool
    deepseek_reasoning_effort: str = "high"
```

在 `normalize_log_level` 校验器下方新增：

```python
    @field_validator("deepseek_reasoning_effort")
    @classmethod
    def normalize_reasoning_effort(cls, value: str) -> str:
        normalized = value.strip().lower()
        allowed = {"low", "medium", "high", "xhigh", "max"}
        if normalized not in allowed:
            raise ValueError(
                f"deepseek_reasoning_effort must be one of {sorted(allowed)}, got {value!r}"
            )
        return normalized
```

- [ ] **Step 4: 更新 `.env.example`**

在 `.env.example` 的 `DEEPSEEK_THINKING_ENABLED=false` 下一行新增：

```
DEEPSEEK_REASONING_EFFORT=high
```

- [ ] **Step 5: 跑测试确认通过**

Run: `uv run pytest tests/core/test_config.py -v`
Expected: PASS（全部，包括既有 `test_env_example_values_match_settings_shape`）。

- [ ] **Step 6: 提交**

```bash
git add app/core/config.py .env.example tests/core/test_config.py
git commit -m "feat(config): add deepseek_reasoning_effort with validation"
```

---

### Task 2: Provider chunk 类型 `ReasoningDelta`

**Files:**
- Modify: `app/providers/types.py`
- Modify: `app/providers/__init__.py`
- Test: `tests/providers/test_types.py`

- [ ] **Step 1: 写失败测试**

在 `tests/providers/test_types.py` 末尾追加（若文件无 import 行，按现有风格补 import）：

```python
def test_reasoning_delta_is_a_frozen_value() -> None:
    from app.providers import ReasoningDelta

    a = ReasoningDelta(text="step 1")
    b = ReasoningDelta(text="step 1")
    assert a == b
    assert a.text == "step 1"
    with pytest.raises(Exception):
        a.text = "mutated"  # frozen dataclass
```

确保文件顶部有 `import pytest`（若没有则添加）。

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/providers/test_types.py::test_reasoning_delta_is_a_frozen_value -v`
Expected: FAIL with `ImportError: cannot import name 'ReasoningDelta'`.

- [ ] **Step 3: 实现类型**

在 `app/providers/types.py` 的 `TextDelta` 下方新增，并扩展联合类型：

```python
@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ReasoningDelta:
    text: str


@dataclass(frozen=True)
class Finish:
    finish_reason: str
    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None


ProviderChunk = TextDelta | ReasoningDelta | Finish
```

在 `app/providers/__init__.py` 的 import 与 `__all__` 中加入 `ReasoningDelta`：

```python
from app.providers.types import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ProviderRole,
    ReasoningDelta,
    TextDelta,
)

__all__ = [
    "Finish",
    "Provider",
    "ProviderChunk",
    "ProviderError",
    "ProviderMessage",
    "ProviderRole",
    "ReasoningDelta",
    "TextDelta",
    "UnknownProviderError",
    "resolve_provider",
]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/providers/test_types.py -v`
Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add app/providers/types.py app/providers/__init__.py tests/providers/test_types.py
git commit -m "feat(providers): add ReasoningDelta chunk type"
```

---

### Task 3: 解析器读取 `delta.reasoning_content`

**Files:**
- Modify: `app/providers/deepseek_parser.py`
- Test: `tests/providers/test_deepseek_parser.py`

- [ ] **Step 1: 写失败测试**

在 `tests/providers/test_deepseek_parser.py` 顶部 import 行追加 `ReasoningDelta`：

```python
from app.providers import Finish, ProviderError, ReasoningDelta, TextDelta
```

末尾追加：

```python
def test_parse_sse_line_returns_reasoning_delta_for_reasoning_content_chunk() -> None:
    line = (
        'data: {"id":"x","choices":[{"index":0,'
        '"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}'
    )

    result = parse_sse_line(line)

    assert result == ReasoningDelta(text="Let me think")


def test_parse_sse_line_prefers_content_when_both_present() -> None:
    # DeepSeek does not interleave the two in one delta, but be deterministic.
    line = (
        'data: {"id":"x","choices":[{"index":0,'
        '"delta":{"content":"answer","reasoning_content":"thought"},"finish_reason":null}]}'
    )

    result = parse_sse_line(line)

    assert result == TextDelta(text="answer")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/providers/test_deepseek_parser.py -k reasoning -v`
Expected: FAIL（reasoning_content 未解析）。

- [ ] **Step 3: 实现解析**

在 `app/providers/deepseek_parser.py` 修改：import 加 `ReasoningDelta`；在 `content` 分支前/后处理 `reasoning_content`。`finish_reason` 优先，其次 `content`，再次 `reasoning_content`：

```python
from app.providers.types import Finish, ProviderChunk, ProviderError, ReasoningDelta, TextDelta
```

```python
    first = choices[0]
    finish_reason = first.get("finish_reason")
    delta = first.get("delta") or {}
    content = delta.get("content")
    reasoning_content = delta.get("reasoning_content")

    if finish_reason is not None:
        usage = data.get("usage")
        if not isinstance(usage, dict):
            usage = None
        return Finish(finish_reason=finish_reason, usage=usage, provider_request_id=None)
    if isinstance(content, str) and content != "":
        return TextDelta(text=content)
    if isinstance(reasoning_content, str) and reasoning_content != "":
        return ReasoningDelta(text=reasoning_content)
    return None
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/providers/test_deepseek_parser.py -v`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add app/providers/deepseek_parser.py tests/providers/test_deepseek_parser.py
git commit -m "feat(providers): parse reasoning_content into ReasoningDelta"
```

---

### Task 4: `stream()` 发送 `reasoning_effort`

**Files:**
- Modify: `app/providers/deepseek.py`
- Test: `tests/providers/test_deepseek_adapter.py`

- [ ] **Step 1: 写失败测试**

在 `tests/providers/test_deepseek_adapter.py` 顶部 import 追加 `ReasoningDelta`：

```python
from app.providers import Finish, ProviderError, ProviderMessage, ReasoningDelta, TextDelta
```

末尾追加：

```python
async def test_stream_sends_reasoning_effort_when_thinking_enabled() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [{"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(
        update={"deepseek_thinking_enabled": True, "deepseek_reasoning_effort": "max"}
    )
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    async for _ in provider.stream(
        model="deepseek-test", messages=[ProviderMessage(role="user", content="hi")]
    ):
        pass

    assert captured_payload["thinking"] == {"type": "enabled"}
    assert captured_payload["reasoning_effort"] == "max"


async def test_stream_omits_reasoning_effort_when_thinking_disabled() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            content=sse_body(
                [{"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
            ),
            headers={"content-type": "text/event-stream"},
        )

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": False})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    async for _ in provider.stream(
        model="deepseek-test", messages=[ProviderMessage(role="user", content="hi")]
    ):
        pass

    assert captured_payload["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in captured_payload


async def test_stream_yields_reasoning_delta_then_text_delta() -> None:
    body = sse_body(
        [
            {"id": "1", "choices": [{"index": 0, "delta": {"reasoning_content": "think"},
                                     "finish_reason": None}]},
            {"id": "1", "choices": [{"index": 0, "delta": {"content": "answer"},
                                     "finish_reason": None}]},
            {"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    settings = make_settings().model_copy(update={"deepseek_thinking_enabled": True})
    provider = DeepSeekProvider(settings=settings, transport=httpx.MockTransport(handler))

    chunks = [
        c
        async for c in provider.stream(
            model="deepseek-test", messages=[ProviderMessage(role="user", content="hi")]
        )
    ]

    assert chunks[0] == ReasoningDelta(text="think")
    assert chunks[1] == TextDelta(text="answer")
    assert isinstance(chunks[2], Finish)
```

> 注意：既有 `test_deepseek_provider_enables_thinking_when_config_true` 不断言 `reasoning_effort`，无需改动；但若该测试用的 `make_settings()` 默认 `deepseek_thinking_enabled` 为 False（来自 `.env.example`），它显式 `model_copy(update={"deepseek_thinking_enabled": True})`，此时 payload 会新增 `reasoning_effort` 字段——该用例只断言 `thinking`，不会因此失败。

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/providers/test_deepseek_adapter.py -k reasoning_effort -v`
Expected: FAIL（payload 无 `reasoning_effort`）。

- [ ] **Step 3: 实现注入**

在 `app/providers/deepseek.py::stream()` 构造 `payload` 后、发请求前，加入条件注入：

```python
        payload = {
            "model": model,
            "stream": True,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "thinking": {
                "type": "enabled" if self._settings.deepseek_thinking_enabled else "disabled"
            },
        }
        if self._settings.deepseek_thinking_enabled:
            payload["reasoning_effort"] = self._settings.deepseek_reasoning_effort
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/providers/test_deepseek_adapter.py -v`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add app/providers/deepseek.py tests/providers/test_deepseek_adapter.py
git commit -m "feat(providers): send reasoning_effort when thinking enabled"
```

---

### Task 5: 迁移 + 模型 + schema（`reasoning_delta` 事件类型、`messages.reasoning` 列）

**Files:**
- Create: `alembic/versions/20260521_0003_add_reasoning_support.py`
- Modify: `app/models/run.py`（`RunEvent.type` CHECK）
- Modify: `app/models/conversation.py`（`Message.reasoning` 列）
- Modify: `app/schemas/runs.py`（`RunEventType` Literal）
- Modify: `app/schemas/conversations.py`（`MessageResponse.reasoning`）

- [ ] **Step 1: 写迁移文件**

创建 `alembic/versions/20260521_0003_add_reasoning_support.py`：

```python
"""add reasoning support: run_events reasoning_delta type, messages.reasoning

Revision ID: 20260521_0003
Revises: 20260519_0002
Create Date: 2026-05-21
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260521_0003"
down_revision: str | None = "20260519_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_TYPES = "'run_started', 'text_delta', 'run_succeeded', 'run_failed', 'run_cancelled'"
_NEW_TYPES = (
    "'run_started', 'text_delta', 'reasoning_delta', "
    "'run_succeeded', 'run_failed', 'run_cancelled'"
)


def upgrade() -> None:
    op.drop_constraint("ck_run_events_type_valid", "run_events", type_="check")
    op.create_check_constraint(
        "ck_run_events_type_valid", "run_events", f"type IN ({_NEW_TYPES})"
    )
    op.add_column("messages", sa.Column("reasoning", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "reasoning")
    op.drop_constraint("ck_run_events_type_valid", "run_events", type_="check")
    op.create_check_constraint(
        "ck_run_events_type_valid", "run_events", f"type IN ({_OLD_TYPES})"
    )
```

- [ ] **Step 2: 更新 ORM 模型**

`app/models/run.py` 中 `RunEvent.__table_args__` 的 CHECK 约束改为含 `reasoning_delta`：

```python
        CheckConstraint(
            "type IN ('run_started', 'text_delta', 'reasoning_delta', "
            "'run_succeeded', 'run_failed', 'run_cancelled')",
            name="type_valid",
        ),
```

`app/models/conversation.py` 的 `Message` 中，在 `content` 字段下方新增：

```python
    content: Mapped[str] = mapped_column(Text, nullable=False)
    reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
```

- [ ] **Step 3: 更新 Pydantic schema**

`app/schemas/runs.py`：

```python
RunEventType = Literal[
    "run_started",
    "text_delta",
    "reasoning_delta",
    "run_succeeded",
    "run_failed",
    "run_cancelled",
]
```

`app/schemas/conversations.py` 的 `MessageResponse` 增加字段：

```python
class MessageResponse(BaseModel):
    id: int
    conversation_id: int
    run_id: int | None
    role: Literal["user", "assistant"]
    content: str
    reasoning: str | None = None
    position: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

- [ ] **Step 4: 应用迁移并验证模型/迁移一致性**

Run:
```bash
uv run alembic upgrade head
uv run pytest tests/db tests/models -v
```
Expected: 迁移成功；`tests/db`、`tests/models` PASS（模型 metadata 与 DB 一致）。

- [ ] **Step 5: 验证迁移可回滚再升级**

Run:
```bash
uv run alembic downgrade -1 && uv run alembic upgrade head
```
Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add alembic/versions/20260521_0003_add_reasoning_support.py app/models/run.py app/models/conversation.py app/schemas/runs.py app/schemas/conversations.py
git commit -m "feat(db): add reasoning_delta event type and messages.reasoning column"
```

---

### Task 6: `/state` 增加 `draft_reasoning`

**Files:**
- Modify: `app/schemas/runs.py`（`RunStateResponse`）
- Modify: `app/services/runs/service.py`（`get_owned_run_state`）
- Test: `tests/services/runs/test_run_service.py`

- [ ] **Step 1: 写失败测试**

在 `tests/services/runs/test_run_service.py` 末尾追加（沿用文件内 `create_user`/`create_run`/`append_run_event` 等 helper 与 `session_factory` fixture）：

```python
async def test_get_owned_run_state_builds_draft_reasoning_from_reasoning_delta_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="succeeded")
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session, run_id=run.id, event_type="reasoning_delta", payload={"text": "think "}
        )
        await append_run_event(
            session, run_id=run.id, event_type="reasoning_delta", payload={"text": "more"}
        )
        await append_run_event(
            session, run_id=run.id, event_type="text_delta", payload={"text": "answer"}
        )
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})

        state = await get_owned_run_state(session, user=user, run_id=run.id)

    assert state.draft_text == "answer"
    assert state.draft_reasoning == "think more"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/services/runs/test_run_service.py -k draft_reasoning -v`
Expected: FAIL（`RunStateResponse` 无 `draft_reasoning`）。

- [ ] **Step 3: 实现**

`app/schemas/runs.py` 的 `RunStateResponse` 增加字段：

```python
class RunStateResponse(BaseModel):
    run_id: int
    status: RunStatus
    latest_seq: int
    draft_text: str
    draft_reasoning: str = ""
    terminal_event: RunEventResponse | None
```

`app/services/runs/service.py::get_owned_run_state` 中累计 reasoning，并在返回时带上：

```python
    latest_seq = 0
    draft_parts: list[str] = []
    reasoning_parts: list[str] = []
    terminal_event: RunEventResponse | None = None

    for event in events:
        latest_seq = event.seq
        if event.type == "text_delta":
            text = event.payload.get("text")
            if isinstance(text, str):
                draft_parts.append(text)
        if event.type == "reasoning_delta":
            text = event.payload.get("text")
            if isinstance(text, str):
                reasoning_parts.append(text)
        if event.type in TERMINAL_EVENT_TYPES:
            terminal_event = run_event_response(event)

    return RunStateResponse(
        run_id=run.id,
        status=cast(RunStatus, run.status),
        latest_seq=latest_seq,
        draft_text="".join(draft_parts),
        draft_reasoning="".join(reasoning_parts),
        terminal_event=terminal_event,
    )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/services/runs/test_run_service.py -v`
Expected: PASS（含既有 `draft_text` 用例）。

- [ ] **Step 5: 提交**

```bash
git add app/schemas/runs.py app/services/runs/service.py tests/services/runs/test_run_service.py
git commit -m "feat(runs): expose draft_reasoning in run state snapshot"
```

---

### Task 7: 物化时写入 `messages.reasoning`

**Files:**
- Modify: `app/services/conversations/service.py`（`materialize_assistant_message`）
- Test: `tests/services/conversations/test_materialize.py`

- [ ] **Step 1: 写失败测试**

在 `tests/services/conversations/test_materialize.py` 末尾追加：

```python
async def test_materialize_assistant_message_stores_reasoning(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        message = await materialize_assistant_message(
            session,
            run_id=run_id,
            content="Final answer",
            reasoning="Chain of thought",
        )
        await session.commit()
        message_id = message.id

    async with session_factory() as session:
        saved = await session.get(Message, message_id)
        assert saved is not None
        assert saved.content == "Final answer"
        assert saved.reasoning == "Chain of thought"


async def test_materialize_assistant_message_reasoning_defaults_to_none(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        message = await materialize_assistant_message(
            session, run_id=run_id, content="Only answer"
        )
        await session.commit()
        message_id = message.id

    async with session_factory() as session:
        saved = await session.get(Message, message_id)
        assert saved is not None
        assert saved.reasoning is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/services/conversations/test_materialize.py -k reasoning -v`
Expected: FAIL（`materialize_assistant_message` 无 `reasoning` 形参）。

- [ ] **Step 3: 实现**

`app/services/conversations/service.py::materialize_assistant_message` 增加可选形参并写入：

```python
async def materialize_assistant_message(
    session: AsyncSession,
    *,
    run_id: int,
    content: str,
    reasoning: str | None = None,
) -> Message:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    next_position = await get_next_message_position(
        session,
        conversation_id=run.conversation_id,
    )
    message = Message(
        conversation_id=run.conversation_id,
        run_id=run.id,
        role="assistant",
        content=content,
        reasoning=reasoning,
        position=next_position,
    )
    session.add(message)
    await session.flush()
```

（其余函数体不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/services/conversations/test_materialize.py -v`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add app/services/conversations/service.py tests/services/conversations/test_materialize.py
git commit -m "feat(conversations): persist reasoning on materialized assistant message"
```

---

### Task 8: Worker channel 批处理（落 `reasoning_delta`，物化传 reasoning）

**Files:**
- Modify: `app/worker/executor.py`（`_run_provider_stream`）
- Modify: `tests/providers/fake.py`（`ScriptItem` 加 `ReasoningDelta`）
- Test: `tests/worker/test_executor_batching.py`、`tests/worker/test_executor.py`

- [ ] **Step 1: 扩展 FakeProvider 脚本类型**

`tests/providers/fake.py`：import 加 `ReasoningDelta`，`ScriptItem` 联合加上它（`stream()` 末尾 `yield item` 已能产出任意 chunk，无需改循环）：

```python
from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ReasoningDelta,
    TextDelta,
)
```

```python
ScriptItem = TextDelta | ReasoningDelta | Finish | RaiseError | Sleep
```

- [ ] **Step 2: 写失败测试（批处理 + 顺序）**

在 `tests/worker/test_executor_batching.py` 顶部 import 追加 `ReasoningDelta`，并新增一个抓取 reasoning 事件的 helper 与测试：

```python
from app.providers import Finish, Provider, ProviderChunk, ProviderMessage, ReasoningDelta, TextDelta
```

```python
async def _fetch_event_types(
    session_factory: async_sessionmaker[AsyncSession], run_id: int
) -> list[tuple[str, str]]:
    async with session_factory() as session:
        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
    return [(e.type, e.payload.get("text", "")) for e in events]


async def test_reasoning_then_text_persist_as_separate_ordered_events(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    run_id = await _setup_claimed_run(session_factory, settings)
    fake = FakeProvider(
        script=[
            ReasoningDelta(text="th"),
            ReasoningDelta(text="ink"),
            TextDelta(text="ans"),
            TextDelta(text="wer"),
            Finish(finish_reason="stop"),
        ]
    )
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    typed = await _fetch_event_types(session_factory, run_id)
    # run_started, then a single coalesced reasoning_delta, then a single text_delta, then succeeded
    assert typed == [
        ("run_started", ""),
        ("reasoning_delta", "think"),
        ("text_delta", "answer"),
        ("run_succeeded", ""),
    ]


async def test_reasoning_only_then_error_does_not_retry(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    """Once reasoning has flushed (run is streaming), a failure must not retry."""
    call_count = {"n": 0}

    class ReasoningThenError(SummarizeMixin, Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(
            self, *, model: str, messages: list[ProviderMessage]
        ) -> AsyncIterator[ProviderChunk]:
            from app.providers import ProviderError

            call_count["n"] += 1
            yield ReasoningDelta(text="thinking hard")
            raise ProviderError(code="upstream_5xx", message="boom")

    run_id = await _setup_claimed_run(session_factory, settings)
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(ReasoningThenError()),
    )

    assert call_count["n"] == 1  # no retry: reasoning flush already marked run streaming
    typed = await _fetch_event_types(session_factory, run_id)
    assert ("reasoning_delta", "thinking hard") in typed
    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
```

- [ ] **Step 3: 写失败测试（物化 reasoning）**

在 `tests/worker/test_executor.py` 顶部 import 追加 `ReasoningDelta`，并新增测试：

```python
from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ReasoningDelta,
    TextDelta,
)
```

```python
async def test_execute_run_materializes_reasoning_on_success(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session, conversation_title="Chat")
        await session.commit()
    async with session_factory() as session:
        await claim_next_queued_run(
            session, worker_id="worker-x", lease_seconds=settings.run_lease_seconds
        )
        await session.commit()

    fake = FakeProvider(
        script=[
            ReasoningDelta(text="Because "),
            ReasoningDelta(text="reasons"),
            TextDelta(text="Hello"),
            Finish(finish_reason="stop"),
        ]
    )
    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        messages = (
            await session.scalars(
                select(Message)
                .where(Message.conversation_id == run.conversation_id)
                .order_by(Message.position.asc())
            )
        ).all()
        assert messages[1].role == "assistant"
        assert messages[1].content == "Hello"
        assert messages[1].reasoning == "Because reasons"
```

- [ ] **Step 4: 跑测试确认失败**

Run: `uv run pytest tests/worker/test_executor_batching.py -k "reasoning" tests/worker/test_executor.py -k "reasoning" -v`
Expected: FAIL（worker 尚未处理 `ReasoningDelta`：reasoning 不会落库、不会物化）。

- [ ] **Step 5: 实现 channel 批处理**

修改 `app/worker/executor.py`：

(a) import 加 `ReasoningDelta`：

```python
from app.providers import Finish, Provider, ProviderError, ProviderMessage, ReasoningDelta, TextDelta
```

(b) 重写 `_run_provider_stream` 中缓冲相关的初始化、`flush_pending` 与 chunk 处理。把单缓冲改为带 channel 的缓冲，并累计 reasoning：

将函数开头的状态初始化改为：

```python
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    pending: list[str] = []
    pending_chars = 0
    pending_channel: str | None = None  # "text" | "reasoning"
    first_flush_done = False
    window_started_at = 0.0

    async def flush_pending() -> bool:
        nonlocal pending_chars, first_flush_done, pending_channel
        if not pending:
            return True
        text = "".join(pending)
        async with session_factory() as session:
            if not first_flush_done:
                changed = await mark_run_streaming(session, run_id=run_id)
                if not changed:
                    await session.commit()
                    return False
                first_flush_done = True
            # Pass the event type as a literal (not a variable) so it satisfies the
            # RunEventType Literal accepted by append_run_event under mypy.
            if pending_channel == "reasoning":
                await append_run_event(
                    session, run_id=run_id, event_type="reasoning_delta", payload={"text": text}
                )
            else:
                await append_run_event(
                    session, run_id=run_id, event_type="text_delta", payload={"text": text}
                )
            await session.commit()
        pending.clear()
        pending_chars = 0
        pending_channel = None
        return True
```

把原 `if isinstance(chunk, TextDelta):` 整个分支替换为下面统一处理 `TextDelta`/`ReasoningDelta` 的分支（其余 `if cancel_event.is_set()`、`elif isinstance(chunk, Finish)` 结构保持）：

```python
            if isinstance(chunk, (TextDelta, ReasoningDelta)):
                channel = "reasoning" if isinstance(chunk, ReasoningDelta) else "text"
                # Channel switch: flush the previous channel before buffering the new one,
                # so reasoning_delta events strictly precede text_delta events in seq order.
                if pending and pending_channel != channel:
                    if not await flush_pending():
                        return _StreamOutcome(
                            status="cancelled",
                            before_first_delta=not first_flush_done,
                            delta_persisted=first_flush_done,
                        )
                if not pending:
                    window_started_at = time.monotonic()
                    pending_channel = channel
                if channel == "reasoning":
                    reasoning_parts.append(chunk.text)
                else:
                    text_parts.append(chunk.text)
                pending.append(chunk.text)
                pending_chars += len(chunk.text)
                if pending_chars >= batch_max_chars:
                    if not await flush_pending():
                        return _StreamOutcome(
                            status="cancelled",
                            before_first_delta=True,
                            delta_persisted=False,
                        )
                if cancel_event.is_set():
                    if pending:
                        await flush_pending()
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
```

在 `elif isinstance(chunk, Finish):` 分支里，把 `full_text` 之后补上 reasoning，并传给物化：

```python
            elif isinstance(chunk, Finish):
                if pending and not await flush_pending():
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
                full_text = "".join(text_parts)
                full_reasoning = "".join(reasoning_parts)
                async with session_factory() as session:
                    changed = await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    if changed:
                        await materialize_assistant_message(
                            session,
                            run_id=run_id,
                            content=full_text,
                            reasoning=full_reasoning or None,
                        )
                    await session.commit()
```

（`if not changed:` 之后的逻辑与既有保持不变。）

- [ ] **Step 6: 跑测试确认通过**

Run: `uv run pytest tests/worker/test_executor_batching.py tests/worker/test_executor.py -v`
Expected: PASS（含既有 text-only 批处理、重试、取消用例）。

- [ ] **Step 7: 提交**

```bash
git add app/worker/executor.py tests/providers/fake.py tests/worker/test_executor_batching.py tests/worker/test_executor.py
git commit -m "feat(worker): persist reasoning_delta events and store reasoning on finish"
```

---

### Task 9: 前端「思考过程」可折叠面板

**Files:**
- Modify: `frontend/views/chat.js`
- Modify: `frontend/styles.css`
- Test: `frontend/views/chat.test.js`

- [ ] **Step 1: 写失败测试**

在 `frontend/views/chat.test.js` 顶部 import 追加 `readReasoningDelta`：

```javascript
import { copyMessageText, readReasoningDelta, readTextDelta, renderAssistantMarkdown } from "./chat.js";
```

末尾追加：

```javascript
test("reads backend reasoning_delta payload text", () => {
  const event = { type: "reasoning_delta", payload: { text: "thinking" } };
  assert.equal(readReasoningDelta(event), "thinking");
});

test("attachRunStream accumulates reasoning into a thinking panel", () => {
  assert.match(chatSource, /event\.type === "reasoning_delta"/);
  assert.match(chatSource, /readReasoningDelta\(event\)/);
  assert.match(chatSource, /updateAssistantReasoning\(/);
});

test("renders a collapsible thinking panel for assistant reasoning", () => {
  assert.match(chatSource, /thinking-panel/);
  assert.match(chatSource, /思考过程/);
  assert.match(chatSource, /buildThinkingPanel\(/);
});

test("thinking panel auto-collapses once the answer starts streaming", () => {
  // text_delta arrival flips the active message's thinking state to "done"
  assert.match(
    chatSource,
    /event\.type === "text_delta"[\s\S]{0,400}updateAssistantReasoning\(placeholderId, reasoningDraft, "done"\)/,
  );
  assert.match(stylesSource, /\.thinking-panel/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test frontend/views/chat.test.js`
Expected: FAIL（`readReasoningDelta` 未导出 / 源码无 thinking 面板）。

- [ ] **Step 3: 实现导出与读取 helper**

在 `frontend/views/chat.js` 末尾、`readTextDelta` 旁新增导出：

```javascript
export function readReasoningDelta(event) {
  return event.payload?.text ?? event.payload?.reasoning ?? "";
}
```

- [ ] **Step 4: 实现思考面板渲染**

在 `frontend/views/chat.js` 的 `renderMessage` 内，构造 `stack` 时，对 assistant 消息在 `bubble` 之前插入面板。先新增 helper：

```javascript
function buildThinkingPanel(message) {
  const reasoning = message.reasoning;
  if (!reasoning) return null;
  const active = message._thinking === "active";
  const details = el("details", {
    class: "thinking-panel mb-2 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2",
  }, [
    el("summary", {
      class: "thinking-summary cursor-pointer select-none text-xs text-zinc-500",
    }, [active ? "思考中…" : "思考过程"]),
    el("div", {
      class: "thinking-content mt-2 whitespace-pre-wrap break-words text-xs text-zinc-500 leading-relaxed",
    }, [reasoning]),
  ]);
  details.open = active;
  return details;
}
```

在 `renderMessage` 中，把 assistant 分支的 `stack` 子节点改为包含面板（user 不变）：

```javascript
  const roleClass = isUser ? "message-item user items-end" : "message-item assistant items-start";
  const thinkingPanel = isUser ? null : buildThinkingPanel(message);
  const stack = el("div", {
    class: `${roleClass} flex max-w-[92%] sm:max-w-[80%] flex-col`,
  }, [thinkingPanel, bubble, actions]);
```

（`el` 会自动跳过为 `null` 的子节点。）

- [ ] **Step 5: 实现流式 reasoning 状态更新**

在 `frontend/views/chat.js` 的 `updateAssistantText` 旁新增：

```javascript
function updateAssistantReasoning(placeholderId, reasoning, phase) {
  const detail = getState().detail;
  if (!detail) return;
  const next = detail.messages.map((m) =>
    m.id === placeholderId ? { ...m, reasoning, _thinking: phase } : m,
  );
  setState({ detail: { ...detail, messages: next } });
}
```

在 `attachRunStream` 中，`let draft = "";` 旁新增 `let reasoningDraft = "";`，并在 `onEvent` 里新增/调整分支：

```javascript
      onEvent: (event) => {
        if (event.type === "reasoning_delta") {
          const delta = readReasoningDelta(event);
          if (delta) {
            reasoningDraft += delta;
            updateAssistantReasoning(placeholderId, reasoningDraft, "active");
            maybeAutoScroll();
          }
        } else if (event.type === "text_delta") {
          const delta = readTextDelta(event);
          if (delta) {
            if (reasoningDraft) {
              updateAssistantReasoning(placeholderId, reasoningDraft, "done");
            }
            draft += delta;
            updateAssistantText(placeholderId, draft);
            maybeAutoScroll();
          }
        } else if (event.type === "run_succeeded") {
          terminalKind = "succeeded";
        } else if (event.type === "run_failed") {
          terminalKind = "failed";
          failureMessage = event.payload?.message || event.payload?.code || "Generation failed";
        } else if (event.type === "run_cancelled") {
          terminalKind = "cancelled";
        }
      },
```

> 说明：成功后 `attachRunStream` 会重新拉取 `conversations.detail`，其中 assistant 消息已带 `reasoning`（`_thinking` 不存在 → 面板默认收起），因此完成后历史展示自然为折叠态。重连（`afterSeq=0`）会重放 `reasoning_delta`，按上面分支重建面板。

- [ ] **Step 6: 加样式**

在 `frontend/styles.css` 末尾追加：

```css
.thinking-panel summary::-webkit-details-marker { display: none; }
.thinking-panel summary { list-style: none; }
.thinking-panel summary::before { content: "▸ "; color: #a1a1aa; }
.thinking-panel[open] summary::before { content: "▾ "; }
.thinking-content { max-height: 18rem; overflow-y: auto; }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test frontend/views/chat.test.js`
Expected: PASS（含既有用例）。

- [ ] **Step 8: 提交**

```bash
git add frontend/views/chat.js frontend/styles.css frontend/views/chat.test.js
git commit -m "feat(frontend): show collapsible thinking panel for reasoning output"
```

---

### Task 10: 全量回归与手动验证

**Files:** 无（仅校验）

- [ ] **Step 1: 后端全量测试**

Run: `uv run pytest -q`
Expected: 全部 PASS。

- [ ] **Step 2: Lint 与类型**

Run: `uv run ruff check app tests && uv run mypy app`
Expected: 无错误。

- [ ] **Step 3: 前端测试**

Run: `node --test frontend/views/chat.test.js`
Expected: 全部 PASS。

- [ ] **Step 4: 手动验证三条数据流**

启动：`docker compose up -d && docker compose exec api alembic upgrade head`（确保 `.env` 中 `DEEPSEEK_THINKING_ENABLED=true`、`DEEPSEEK_REASONING_EFFORT=high`）。在浏览器中：
1. **实时思考**：发一条需要推理的消息，确认「思考中…」面板实时展开滚动，正文开始后自动收起。
2. **中途重连**：思考进行时刷新页面，确认重连后能看到已生成的思考过程并继续。
3. **历史回看**：等对话完成后刷新/重开该对话，确认 assistant 消息上方有可点开的「思考过程」面板。

- [ ] **Step 5:（无独立提交）** 如手动验证发现问题，回到相应 Task 修复并提交。

---

## 自查（Self-Review）记录

- **Spec 覆盖**：配置(Task 1) / Provider 类型(2) / 解析(3) / 发送 effort(4) / 迁移+模型+schema(5) / `/state` draft_reasoning(6) / 物化 reasoning(7) / worker channel 批处理(8) / 前端面板(9) / 回归(10)，覆盖 spec 全部「涉及文件」与「测试与验证」。
- **类型一致性**：`ReasoningDelta` 全程一致；事件类型字符串统一为 `reasoning_delta`；`materialize_assistant_message(reasoning=...)` 与 worker 调用一致；前端 `readReasoningDelta` / `updateAssistantReasoning` / `buildThinkingPanel` / `_thinking` 标志在测试与实现间一致。
- **边界**：取消/失败不物化（与正文对称）；reasoning flush 触发 streaming 从而禁用重试、避免重复——已由 `test_reasoning_only_then_error_does_not_retry` 覆盖。
- **非目标**：未触碰工具调用、未做 per-conversation effort、`summarize()` 未改（仍 `thinking disabled`、不发 effort）。
