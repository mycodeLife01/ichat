# Run Events And SSE Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 实现 run event 持久化写入、基于 `after_seq` 的 SSE replay/tail，以及用于页面恢复的 run 当前草稿 state 查询。

**架构：** `app/services/runs` 承载 run ownership 校验、event seq 分配、event 查询和 state 聚合。`app/api/v1/runs.py` 只负责依赖注入、调用 service、SSE 格式化和返回响应；HTTP 连接只观察 run，不拥有 run 生命周期。`run_events` 继续作为本次功能的事实源，不新增数据库迁移，也不接入 provider 或 worker。

**技术栈：** Python 3.12、FastAPI、StreamingResponse、Pydantic v2、SQLAlchemy 2.0 async、PostgreSQL、pytest、httpx ASGITransport。

---

## 范围约束

本计划基于以下文档和已确认决策：

- `docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md`
- `docs/handover/2026-05-17-conversation-module.md`
- `docs/architecture/module-boundaries.md`

本次实现包含：

- 在 `app/services/runs` 实现 run ownership 查询。
- 所有 run API 必须通过 `run -> conversation -> user` 校验当前用户。
- conversation 已软删除时，run API 返回 `404 Run not found`。
- 实现 run event 写入 helper，保证同一 run 内 `seq` 从 `1` 开始单调递增。
- 实现 `GET /api/v1/runs/{run_id}/events?after_seq=0`。
- SSE endpoint 先 replay `seq > after_seq` 的已持久化 events，再 tail 新持久化 events。
- SSE endpoint 观察到 `run_succeeded`、`run_failed` 或 `run_cancelled` 后结束。
- 当 terminal event 已经存在且 `after_seq` 已越过 terminal event 时，SSE endpoint 立即结束，避免挂住。
- 实现 `GET /api/v1/runs/{run_id}/state`，返回当前 `draft_text`、`latest_seq`、run status 和 terminal event。
- 使用数据库中 fake persisted events 测试 replay 和 state 语义。

本次明确不做：

- 不实现 provider interface、DeepSeek adapter 或 fake provider。
- 不启动 worker，不实现 worker claim、lease、heartbeat 或 recovery。
- 不实现 run cancellation API。
- 不实现 regenerate。
- 不物化 assistant message。
- 不实现 `Last-Event-ID`。
- 不新增 Alembic migration；`runs` 和 `run_events` 已在 `20260516_0001_create_core_tables.py` 中存在。

项目规则：

- 直接在当前分支开发，不创建或切换 git worktree。
- 文档使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。
- SSE 成功响应不使用 `SuccessResponse` envelope；JSON 成功响应继续使用 `{"data": ...}` envelope。

## 用户重放体验设计

页面重新打开时，前端不应该从空白开始逐个播放历史 delta，而应该先显示该 run 当前已经生成出的完整 assistant 草稿，再继续追加新 delta。

推荐前端流程：

1. 前端打开 conversation detail，定位需要恢复的 `run_id`。
2. 调用 `GET /api/v1/runs/{run_id}/state`。
3. 立即渲染 `draft_text`。
4. 如果 `terminal_event` 为 `null`，再打开 `GET /api/v1/runs/{run_id}/events?after_seq=<latest_seq>`。
5. 后续只 append 新收到的 `text_delta`。

这个设计没有漏 event 的竞态：如果 `/state` 返回后、SSE 连接前 worker 又写入了新 event，SSE endpoint 会先 replay `seq > latest_seq` 的已存储 events，再 tail 更新。

## 文件结构

执行完成后，应新增或修改以下文件。

**Schemas：**

- Create: `app/schemas/runs.py`，定义 run event SSE data 和 run state JSON response。
- Create: `tests/schemas/test_run_schemas.py`，覆盖 schema 序列化和 terminal event 嵌套。

**Service：**

- Create: `app/services/runs/__init__.py`，导出 runs service public API。
- Create: `app/services/runs/service.py`，实现 ownership、event 写入、event 查询、terminal 判断和 state 聚合。
- Create: `tests/services/runs/test_run_service.py`，覆盖 seq 分配、after_seq 查询、state 聚合、ownership 和软删除隔离。使用唯一文件名，避免与 `tests/services/conversations/test_service.py` 在 pytest 全量收集时同名冲突。

**API：**

- Create: `app/api/v1/runs.py`，实现 `/state` JSON endpoint 和 `/events` SSE endpoint。
- Modify: `app/main.py`，挂载 runs router。
- Create: `tests/api/test_runs.py`，覆盖认证、跨用户访问、`after_seq` 校验、persisted replay、tail 和 terminal 结束行为。

**不修改：**

- `alembic/versions/20260516_0001_create_core_tables.py`
- `app/models/run.py`
- `app/models/conversation.py`

## Task 1: Run Schemas

**Files:**

- Create: `app/schemas/runs.py`
- Create: `tests/schemas/test_run_schemas.py`

- [ ] **Step 1: 写 schema 失败测试**

创建 `tests/schemas/test_run_schemas.py`：

```python
from datetime import UTC, datetime

from app.schemas.runs import RunEventResponse, RunStateResponse


def test_run_event_response_serializes_event_data() -> None:
    event = RunEventResponse(
        seq=2,
        type="text_delta",
        payload={"text": "Hello"},
        created_at=datetime(2026, 5, 17, 12, 0, tzinfo=UTC),
    )

    assert event.seq == 2
    assert event.type == "text_delta"
    assert event.payload == {"text": "Hello"}
    assert '"seq":2' in event.model_dump_json()
    assert '"type":"text_delta"' in event.model_dump_json()


def test_run_state_response_contains_draft_and_terminal_event() -> None:
    terminal = RunEventResponse(
        seq=4,
        type="run_succeeded",
        payload={},
        created_at=datetime(2026, 5, 17, 12, 1, tzinfo=UTC),
    )

    state = RunStateResponse(
        run_id=10,
        status="succeeded",
        latest_seq=4,
        draft_text="Hello world",
        terminal_event=terminal,
    )

    assert state.run_id == 10
    assert state.status == "succeeded"
    assert state.latest_seq == 4
    assert state.draft_text == "Hello world"
    assert state.terminal_event == terminal
```

- [ ] **Step 2: 运行 schema 测试确认失败**

Run:

```bash
uv run pytest tests/schemas/test_run_schemas.py -v
```

Expected:

- FAIL。
- 失败原因包含 `ModuleNotFoundError: No module named 'app.schemas.runs'`。

- [ ] **Step 3: 实现 run schema**

创建 `app/schemas/runs.py`：

```python
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

RunEventType = Literal[
    "run_started",
    "text_delta",
    "run_succeeded",
    "run_failed",
    "run_cancelled",
]

RunStatus = Literal[
    "queued",
    "started",
    "streaming",
    "succeeded",
    "failed",
    "cancelling",
    "cancelled",
]


class RunEventResponse(BaseModel):
    seq: int
    type: RunEventType
    payload: dict[str, Any]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RunStateResponse(BaseModel):
    run_id: int
    status: RunStatus
    latest_seq: int
    draft_text: str
    terminal_event: RunEventResponse | None
```

- [ ] **Step 4: 运行 schema 测试确认通过**

Run:

```bash
uv run pytest tests/schemas/test_run_schemas.py -v
```

Expected:

- PASS，`2 passed`。

- [ ] **Step 5: 提交 schema 任务**

Run:

```bash
git add app/schemas/runs.py tests/schemas/test_run_schemas.py
git commit -m "feat: add run event schemas"
```

Expected:

- Commit 成功。

## Task 2: Runs Service

**Files:**

- Create: `app/services/runs/__init__.py`
- Create: `app/services/runs/service.py`
- Create: `tests/services/runs/test_run_service.py`

- [ ] **Step 1: 写 service 失败测试**

创建 `tests/services/runs/test_run_service.py`：

```python
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.runs.service import (
    append_run_event,
    get_owned_run_state,
    get_owned_visible_run,
    list_owned_run_events_after,
    run_has_terminal_event,
)

TEST_DATABASE_URL = os.environ.get(
    "RUN_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "runs-service-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()

    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as session:
        await clean_test_data(session)
        await session.commit()

    yield factory

    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def create_user(session: AsyncSession, username: str) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{username}-{suffix}",
        email=f"{username}-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def create_run(
    session: AsyncSession,
    *,
    user: User,
    status_value: str = "streaming",
) -> tuple[Conversation, Message, Run]:
    conversation = Conversation(user_id=user.id, title="Run chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status=status_value,
        provider_name="deepseek",
        provider_model="deepseek-chat",
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    await session.flush()
    return conversation, message, run


async def test_append_run_event_assigns_monotonic_seq(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user)

        started = await append_run_event(
            session,
            run_id=run.id,
            event_type="run_started",
            payload={},
        )
        delta = await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await session.commit()

        stored_events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.seq.asc())
            )
        ).all()

    assert started.seq == 1
    assert delta.seq == 2
    assert [event.seq for event in stored_events] == [1, 2]
    assert stored_events[1].payload == {"text": "Hello"}


async def test_list_owned_run_events_after_filters_by_seq(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user)
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(
            session,
            run_id=run.id,
            event_type="run_succeeded",
            payload={},
        )

        events = await list_owned_run_events_after(
            session,
            user=user,
            run_id=run.id,
            after_seq=1,
        )

    assert [event.seq for event in events] == [2, 3]
    assert [event.type for event in events] == ["text_delta", "run_succeeded"]


async def test_get_owned_run_state_builds_draft_from_text_delta_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="succeeded")
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": " world"},
        )
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})

        state = await get_owned_run_state(session, user=user, run_id=run.id)

    assert state.run_id == run.id
    assert state.status == "succeeded"
    assert state.latest_seq == 4
    assert state.draft_text == "Hello world"
    assert state.terminal_event is not None
    assert state.terminal_event.type == "run_succeeded"


async def test_run_has_terminal_event_detects_terminal_events(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user)

        before = await run_has_terminal_event(session, run_id=run.id)
        await append_run_event(session, run_id=run.id, event_type="run_failed", payload={})
        after = await run_has_terminal_event(session, run_id=run.id)

    assert before is False
    assert after is True


async def test_cross_user_run_access_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        other_user = await create_user(session, "bob")
        _, _, run = await create_run(session, user=owner)

        with pytest.raises(AppError) as exc_info:
            await get_owned_visible_run(session, user=other_user, run_id=run.id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"


async def test_deleted_conversation_run_access_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, _, run = await create_run(session, user=user)
        conversation.deleted_at = datetime.now(UTC)
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await get_owned_run_state(session, user=user, run_id=run.id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"
```

- [ ] **Step 2: 运行 service 测试确认失败**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py -v
```

Expected:

- FAIL。
- 失败原因包含 `ModuleNotFoundError: No module named 'app.services.runs'`。

- [ ] **Step 3: 实现 runs service public exports**

创建 `app/services/runs/__init__.py`：

```python
from app.services.runs.service import (
    RUN_NOT_FOUND_MESSAGE,
    TERMINAL_EVENT_TYPES,
    append_run_event,
    get_owned_run_state,
    get_owned_visible_run,
    list_owned_run_events_after,
    list_run_events_after,
    run_has_terminal_event,
)

__all__ = [
    "RUN_NOT_FOUND_MESSAGE",
    "TERMINAL_EVENT_TYPES",
    "append_run_event",
    "get_owned_run_state",
    "get_owned_visible_run",
    "list_owned_run_events_after",
    "list_run_events_after",
    "run_has_terminal_event",
]
```

- [ ] **Step 4: 实现 runs service**

创建 `app/services/runs/service.py`：

```python
from typing import Any

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.conversation import Conversation
from app.models.run import Run, RunEvent
from app.models.user import User
from app.schemas.runs import RunEventResponse, RunEventType, RunStateResponse

RUN_NOT_FOUND_MESSAGE = "Run not found"
TERMINAL_EVENT_TYPES: tuple[RunEventType, ...] = (
    "run_succeeded",
    "run_failed",
    "run_cancelled",
)


def run_event_response(event: RunEvent) -> RunEventResponse:
    return RunEventResponse.model_validate(event)


async def get_owned_visible_run(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
) -> Run:
    run = await session.scalar(
        select(Run)
        .join(Conversation, Run.conversation_id == Conversation.id)
        .where(
            Run.id == run_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
    )
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)
    return run


async def append_run_event(
    session: AsyncSession,
    *,
    run_id: int,
    event_type: RunEventType,
    payload: dict[str, Any],
) -> RunEventResponse:
    run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)

    next_seq = await get_next_run_event_seq(session, run_id=run.id)
    event = RunEvent(
        run_id=run.id,
        seq=next_seq,
        type=event_type,
        payload=payload,
    )
    session.add(event)
    await session.flush()
    return run_event_response(event)


async def list_owned_run_events_after(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
    after_seq: int,
) -> list[RunEventResponse]:
    run = await get_owned_visible_run(session, user=user, run_id=run_id)
    return await list_run_events_after(session, run_id=run.id, after_seq=after_seq)


async def list_run_events_after(
    session: AsyncSession,
    *,
    run_id: int,
    after_seq: int,
) -> list[RunEventResponse]:
    events = (
        await session.scalars(
            select(RunEvent)
            .where(
                RunEvent.run_id == run_id,
                RunEvent.seq > after_seq,
            )
            .order_by(RunEvent.seq.asc())
        )
    ).all()
    return [run_event_response(event) for event in events]


async def get_owned_run_state(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
) -> RunStateResponse:
    run = await get_owned_visible_run(session, user=user, run_id=run_id)
    events = (
        await session.scalars(
            select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.seq.asc())
        )
    ).all()

    latest_seq = 0
    draft_parts: list[str] = []
    terminal_event: RunEventResponse | None = None

    for event in events:
        latest_seq = event.seq
        if event.type == "text_delta":
            text = event.payload.get("text")
            if isinstance(text, str):
                draft_parts.append(text)
        if event.type in TERMINAL_EVENT_TYPES:
            terminal_event = run_event_response(event)

    return RunStateResponse(
        run_id=run.id,
        status=run.status,
        latest_seq=latest_seq,
        draft_text="".join(draft_parts),
        terminal_event=terminal_event,
    )


async def run_has_terminal_event(session: AsyncSession, *, run_id: int) -> bool:
    event_id = await session.scalar(
        select(RunEvent.id)
        .where(
            RunEvent.run_id == run_id,
            RunEvent.type.in_(TERMINAL_EVENT_TYPES),
        )
        .limit(1)
    )
    return event_id is not None


async def get_next_run_event_seq(session: AsyncSession, *, run_id: int) -> int:
    max_seq = await session.scalar(select(func.max(RunEvent.seq)).where(RunEvent.run_id == run_id))
    if max_seq is None:
        return 1
    return max_seq + 1
```

- [ ] **Step 5: 运行 service 测试确认通过**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py -v
```

Expected:

- PASS，`6 passed`。

- [ ] **Step 6: 运行 schema + service 测试**

Run:

```bash
uv run pytest tests/schemas/test_run_schemas.py tests/services/runs/test_run_service.py -v
```

Expected:

- PASS。

- [ ] **Step 7: 提交 service 任务**

Run:

```bash
git add app/services/runs tests/services/runs/test_run_service.py
git commit -m "feat: add run event service"
```

Expected:

- Commit 成功。

## Task 3: Run State API

**Files:**

- Create: `app/api/v1/runs.py`
- Modify: `app/main.py`
- Create: `tests/api/test_runs.py`

- [ ] **Step 1: 写 `/state` API 失败测试**

创建 `tests/api/test_runs.py`：

```python
import os
from collections.abc import AsyncIterator
from typing import Any, cast

import pytest
from fastapi import FastAPI, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.session import get_session
from app.main import create_app
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.runs.service import append_run_event

TEST_DATABASE_URL = os.environ.get(
    "RUN_API_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "runs-api-test.example.com"


async def ready() -> bool:
    return True


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()

    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as session:
        await clean_test_data(session)
        await session.commit()

    yield factory

    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


@pytest.fixture()
async def app(session_factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[FastAPI]:
    app = create_app(database_ready_check=ready)

    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    yield app
    app.dependency_overrides.clear()


@pytest.fixture()
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


async def register_user(
    client: AsyncClient,
    *,
    username: str,
    email: str,
) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "email": email, "password": "correct-password"},
    )
    assert response.status_code == status.HTTP_201_CREATED
    return cast(dict[str, Any], response.json()["data"])


def auth_headers(token_data: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {token_data['access_token']}"}


async def create_run_for_user(
    session: AsyncSession,
    *,
    user_id: int,
    status_value: str = "streaming",
) -> Run:
    conversation = Conversation(user_id=user_id, title="Run chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status=status_value,
        provider_name="deepseek",
        provider_model="deepseek-chat",
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    await session.flush()
    return run


async def test_get_run_state_returns_current_draft(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-run-state-api",
        email=f"alice-state@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="streaming",
        )
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": " world"},
        )
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/state", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.json()["data"] == {
        "run_id": run_id,
        "status": "streaming",
        "latest_seq": 3,
        "draft_text": "Hello world",
        "terminal_event": None,
    }


async def test_run_state_requires_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/v1/runs/1/state")

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json() == {"detail": "Authentication required"}


async def test_cross_user_run_state_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-private-run-api",
        email=f"alice-private@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-private-run-api",
        email=f"bob-private@{TEST_EMAIL_DOMAIN}",
    )
    bob_headers = auth_headers(bob)

    async with session_factory() as session:
        run = await create_run_for_user(session, user_id=alice["user"]["id"])
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/state", headers=bob_headers)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Run not found"}
```

- [ ] **Step 2: 运行 `/state` API 测试确认失败**

Run:

```bash
uv run pytest tests/api/test_runs.py::test_get_run_state_returns_current_draft -v
```

Expected:

- FAIL。
- 失败原因为 `404 Not Found`，因为 runs router 尚未挂载。

- [ ] **Step 3: 实现 runs router 的 `/state` endpoint**

创建 `app/api/v1/runs.py`：

```python
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.user import User
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunStateResponse
from app.services.auth.dependencies import get_current_user
from app.services.runs.service import get_owned_run_state

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


@router.get(
    "/{run_id}/state",
    response_model=SuccessResponse[RunStateResponse],
)
async def get_run_state_route(
    run_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[RunStateResponse]:
    state = await get_owned_run_state(session, user=current_user, run_id=run_id)
    return SuccessResponse(data=state)
```

修改 `app/main.py`：

```python
from app.api.v1.auth import router as auth_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.runs import router as runs_router
```

在 `create_app()` 中挂载 runs router：

```python
    app = FastAPI(title="iChat API")
    app.include_router(auth_router)
    app.include_router(conversations_router)
    app.include_router(runs_router)
```

- [ ] **Step 4: 运行 `/state` API 测试确认通过**

Run:

```bash
uv run pytest tests/api/test_runs.py::test_get_run_state_returns_current_draft tests/api/test_runs.py::test_run_state_requires_authentication tests/api/test_runs.py::test_cross_user_run_state_returns_not_found -v
```

Expected:

- PASS，`3 passed`。

- [ ] **Step 5: 提交 run state API 任务**

Run:

```bash
git add app/api/v1/runs.py app/main.py tests/api/test_runs.py
git commit -m "feat: add run state api"
```

Expected:

- Commit 成功。

## Task 4: SSE Replay API

**Files:**

- Modify: `app/api/v1/runs.py`
- Modify: `tests/api/test_runs.py`

- [ ] **Step 1: 追加 SSE persisted replay 失败测试**

在 `tests/api/test_runs.py` 追加：

```python
async def test_run_events_replay_starts_after_seq_and_stops_at_terminal(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-run-events-api",
        email=f"alice-events@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="succeeded",
        )
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(
            session,
            run_id=run.id,
            event_type="text_delta",
            payload={"text": "Hello"},
        )
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/events?after_seq=1", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert "id: 1" not in body
    assert "event: run_started" not in body
    assert "id: 2" in body
    assert "event: text_delta" in body
    assert '"payload":{"text":"Hello"}' in body
    assert "id: 3" in body
    assert "event: run_succeeded" in body


async def test_run_events_returns_empty_stream_when_after_seq_passed_terminal(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-terminal-passed-api",
        email=f"alice-terminal-passed@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="succeeded",
        )
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        await append_run_event(session, run_id=run.id, event_type="run_succeeded", payload={})
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/events?after_seq=2", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.text == ""


async def test_run_events_rejects_negative_after_seq(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-run-events-invalid-api",
        email=f"alice-events-invalid@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    response = await client.get("/api/v1/runs/1/events?after_seq=-1", headers=headers)

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


async def test_cross_user_run_events_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-private-events-api",
        email=f"alice-private-events@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-private-events-api",
        email=f"bob-private-events@{TEST_EMAIL_DOMAIN}",
    )
    bob_headers = auth_headers(bob)

    async with session_factory() as session:
        run = await create_run_for_user(session, user_id=alice["user"]["id"])
        run_id = run.id
        await session.commit()

    response = await client.get(f"/api/v1/runs/{run_id}/events", headers=bob_headers)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Run not found"}
```

- [ ] **Step 2: 运行 SSE replay 测试确认失败**

Run:

```bash
uv run pytest tests/api/test_runs.py::test_run_events_replay_starts_after_seq_and_stops_at_terminal -v
```

Expected:

- FAIL。
- 失败原因为 `404 Not Found`，因为 `/events` endpoint 尚未实现。

- [ ] **Step 3: 实现 SSE replay endpoint**

修改 `app/api/v1/runs.py`，保留已有 `/state` endpoint，并补齐以下内容：

```python
import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.models.user import User
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunEventResponse, RunStateResponse
from app.services.auth.dependencies import get_current_user
from app.services.runs.service import (
    TERMINAL_EVENT_TYPES,
    get_owned_run_state,
    get_owned_visible_run,
    list_run_events_after,
    run_has_terminal_event,
)

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])
SSE_POLL_INTERVAL_SECONDS = 0.2


@router.get(
    "/{run_id}/state",
    response_model=SuccessResponse[RunStateResponse],
)
async def get_run_state_route(
    run_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[RunStateResponse]:
    state = await get_owned_run_state(session, user=current_user, run_id=run_id)
    return SuccessResponse(data=state)


@router.get("/{run_id}/events")
async def stream_run_events_route(
    run_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    after_seq: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse:
    await get_owned_visible_run(session, user=current_user, run_id=run_id)

    async def event_stream() -> AsyncIterator[str]:
        cursor = after_seq
        while True:
            events = await list_run_events_after(session, run_id=run_id, after_seq=cursor)
            for event in events:
                cursor = event.seq
                yield format_sse_event(event)
                if event.type in TERMINAL_EVENT_TYPES:
                    return

            if await run_has_terminal_event(session, run_id=run_id):
                return

            await asyncio.sleep(SSE_POLL_INTERVAL_SECONDS)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def format_sse_event(event: RunEventResponse) -> str:
    return f"id: {event.seq}\nevent: {event.type}\ndata: {event.model_dump_json()}\n\n"
```

- [ ] **Step 4: 运行 SSE replay 测试确认通过**

Run:

```bash
uv run pytest tests/api/test_runs.py::test_run_events_replay_starts_after_seq_and_stops_at_terminal tests/api/test_runs.py::test_run_events_returns_empty_stream_when_after_seq_passed_terminal tests/api/test_runs.py::test_run_events_rejects_negative_after_seq tests/api/test_runs.py::test_cross_user_run_events_returns_not_found -v
```

Expected:

- PASS，`4 passed`。

- [ ] **Step 5: 提交 SSE replay API 任务**

Run:

```bash
git add app/api/v1/runs.py tests/api/test_runs.py
git commit -m "feat: add run event sse replay"
```

Expected:

- Commit 成功。

## Task 5: SSE Tail Behavior

**Files:**

- Modify: `tests/api/test_runs.py`

- [ ] **Step 1: 追加 tail 新持久化 event 的测试**

在 `tests/api/test_runs.py` 顶部增加 import：

```python
import asyncio
```

在文件末尾追加：

```python
async def test_run_events_tails_new_persisted_events_until_terminal(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-tail-events-api",
        email=f"alice-tail-events@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="streaming",
        )
        run_id = run.id
        await session.commit()

    response_task = asyncio.create_task(
        client.get(f"/api/v1/runs/{run_id}/events?after_seq=0", headers=headers, timeout=3.0)
    )

    await asyncio.sleep(0.3)

    async with session_factory() as session:
        await append_run_event(
            session,
            run_id=run_id,
            event_type="text_delta",
            payload={"text": "Late hello"},
        )
        await append_run_event(session, run_id=run_id, event_type="run_succeeded", payload={})
        await session.commit()

    response = await asyncio.wait_for(response_task, timeout=3.0)

    assert response.status_code == status.HTTP_200_OK
    body = response.text
    assert "event: text_delta" in body
    assert '"payload":{"text":"Late hello"}' in body
    assert "event: run_succeeded" in body
```

- [ ] **Step 2: 运行 tail 测试**

Run:

```bash
uv run pytest tests/api/test_runs.py::test_run_events_tails_new_persisted_events_until_terminal -v
```

Expected:

- PASS。

如果失败且错误是测试超时，先确认：

- `app/api/v1/runs.py` 的 `SSE_POLL_INTERVAL_SECONDS` 为 `0.2`。
- 测试中 terminal event 已提交。
- `/events` generator 在 `run_has_terminal_event()` 为 true 时会 return。

- [ ] **Step 3: 运行完整 runs API 测试**

Run:

```bash
uv run pytest tests/api/test_runs.py -v
```

Expected:

- PASS，包含 state、persisted replay、tail、auth、ownership 和 validation 测试。

- [ ] **Step 4: 提交 tail 测试任务**

Run:

```bash
git add tests/api/test_runs.py
git commit -m "test: cover run event sse tailing"
```

Expected:

- Commit 成功。

## Task 6: Regression And Quality Gates

**Files:**

- Modify only if verification reveals a real issue in files touched by this plan.

- [ ] **Step 1: 运行 focused tests**

Run:

```bash
uv run pytest tests/schemas/test_run_schemas.py tests/services/runs/test_run_service.py tests/api/test_runs.py -v
```

Expected:

- PASS。

- [ ] **Step 2: 运行 API regression tests**

Run:

```bash
uv run pytest tests/api/test_app.py tests/api/test_auth.py tests/api/test_conversations.py tests/api/test_runs.py -v
```

Expected:

- PASS。

- [ ] **Step 3: 运行全量测试**

Run:

```bash
uv run pytest
```

Expected:

- PASS。

- [ ] **Step 4: 运行 lint**

Run:

```bash
uv run ruff check .
```

Expected:

- PASS，输出包含 `All checks passed!`。

- [ ] **Step 5: 运行类型检查**

Run:

```bash
uv run mypy .
```

Expected:

- PASS，输出包含 `Success: no issues found`。

- [ ] **Step 6: 检查工作区变更**

Run:

```bash
git status --short
```

Expected:

- 只包含本计划涉及的文件，或者为空。
- 不应出现 Alembic migration、model schema 约束或无关文档变更。

- [ ] **Step 7: 最终提交**

如果 Task 6 中修复了问题，提交修复：

```bash
git add app/schemas/runs.py app/services/runs app/api/v1/runs.py app/main.py tests/schemas/test_run_schemas.py tests/services/runs/test_run_service.py tests/api/test_runs.py
git commit -m "chore: verify run events sse replay"
```

Expected:

- 如果没有额外修复，则不创建空提交。
- 如果有修复，commit 成功。

## 实现注意事项

- `append_run_event()` 必须锁定目标 `runs` 行后再查询 `max(seq)`，确保所有使用该 helper 的并发 writer 在同一 run 上串行分配 seq。
- `append_run_event()` 不校验 user ownership，因为未来 worker 也会使用它；HTTP API 层必须通过 `get_owned_visible_run()` 或 `get_owned_run_state()` 校验当前用户。
- `/events` 在返回 `StreamingResponse` 前先调用 `get_owned_visible_run()`，让跨用户和软删除场景在进入 stream 前返回标准 JSON error。
- `/events` 的成功响应是 `text/event-stream`，不使用 `SuccessResponse`。
- `/state` 是 JSON API，必须使用 `SuccessResponse[RunStateResponse]`。
- `/state` 必须显式返回 `terminal_event: null`，方便前端区分“未终止”和“字段被省略”；因此该 endpoint 不使用 `response_model_exclude_none=True`。
- `RunStateResponse.draft_text` 只拼接 `text_delta.payload.text` 为字符串的内容。
- terminal event 只由 `run_succeeded`、`run_failed`、`run_cancelled` 判定，不直接依赖 `runs.status`。
- 如果 `runs.status` 已 terminal 但没有 terminal event，本次 SSE endpoint 不应擅自合成 event；后续 worker/状态机任务负责保证 terminal event 写入。
- conversation 软删除后 run API 返回 `404 Run not found`，但数据库中的 events 不删除。

## 自查清单

- Spec coverage：
  - run event 写入 helper：Task 2。
  - run 内 seq 单调递增：Task 2。
  - run ownership 通过 conversation 校验：Task 2、Task 3、Task 4。
  - `GET /api/v1/runs/{run_id}/events?after_seq=0`：Task 4。
  - replay `seq > after_seq`：Task 4。
  - tail 新持久化 events：Task 5。
  - terminal event 后结束：Task 4、Task 5。
  - 页面恢复时从当前最新草稿开始渲染：Task 3 的 `/state`。
  - 不接 provider/worker/cancel/regenerate：范围约束已明确。
- Placeholder scan：
  - 已检查常见占位表达，正文没有未完成标记或跨任务省略写法。
- Type consistency：
  - `RunEventResponse`、`RunStateResponse`、`RunEventType` 在 Task 1 定义，并在 Task 2 和 Task 4 使用。
  - `get_owned_visible_run()`、`append_run_event()`、`list_run_events_after()`、`run_has_terminal_event()` 的签名在测试和实现中一致。
  - API route 中的 `after_seq` 使用 `Query(ge=0)`，测试期望 `422`。
