# Run Cancellation 实现计划

> **给 agentic workers：** 必须使用子技能：实现本计划时使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 实现 `POST /api/v1/runs/{run_id}/cancel`，让用户可以显式取消自己拥有的 run，并与现有 worker 的 `cancelling` 检测机制对接。

**架构：** API handler 保持 thin，只负责认证、调用 service、提交事务和返回 `SuccessResponse`。取消写路径放在 `app/services/runs/service.py`：queued run 直接写成 `cancelled` 并持久化 `run_cancelled` event；started/streaming run 写成 `cancelling`，由 worker heartbeat 观察并最终关闭 provider stream；cancelling 和 terminal run 幂等返回成功。

**技术栈：** Python 3.12、FastAPI、SQLAlchemy 2.0 async、PostgreSQL、pytest、ruff、mypy。

---

## 文件结构

- 修改 `app/services/runs/service.py`
  - 新增取消状态常量。
  - 新增 `cancel_owned_run(session, *, user, run_id)`。
  - 使用 `Run -> Conversation -> User` ownership 校验，并用 `SELECT ... FOR UPDATE` 锁定 run 行。
  - queued run 直接写 terminal event；started/streaming run 只置为 `cancelling`。
- 修改 `app/services/runs/__init__.py`
  - 导出 `cancel_owned_run`。
- 修改 `app/api/v1/runs.py`
  - 引入 `CommandStatusResponse`。
  - 新增 `POST /api/v1/runs/{run_id}/cancel` route。
- 修改 `tests/services/runs/test_run_service.py`
  - 覆盖 queued、streaming、terminal 幂等、跨用户、软删除 conversation。
- 修改 `tests/api/test_runs.py`
  - 覆盖认证、queued API 行为、streaming API 行为、terminal 幂等、跨用户。

不新增数据库迁移，不修改 provider/worker 逻辑，不改变 SSE 和 `/state` 语义。

---

### Task 1: Runs service 取消行为测试

**Files:**
- Modify: `tests/services/runs/test_run_service.py:15-21`
- Modify: `tests/services/runs/test_run_service.py:249-end`

- [ ] **Step 1: 写入失败测试**

在 `tests/services/runs/test_run_service.py` 的 import block 中加入 `cancel_owned_run`，并从 run schemas 导入 `RunEventType`：

```python
from app.schemas.runs import RunEventType
from app.services.runs.service import (
    append_run_event,
    cancel_owned_run,
    get_owned_run_state,
    get_owned_visible_run,
    list_owned_run_events_after,
    run_has_terminal_event,
)
```

在文件末尾追加以下测试：

```python
async def test_cancel_owned_queued_run_marks_cancelled_and_writes_terminal_event(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="queued")
        run_id = run.id
        result = await cancel_owned_run(session, user=user, run_id=run_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelled"
        assert updated.cancelled_at is not None
        assert updated.completed_at is not None
        assert updated.lease_owner is None
        assert updated.lease_expires_at is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [(event.seq, event.type, event.payload) for event in events] == [
            (1, "run_cancelled", {})
        ]


@pytest.mark.parametrize("active_status", ["started", "streaming"])
async def test_cancel_owned_active_run_marks_cancelling_without_terminal_event(
    session_factory: async_sessionmaker[AsyncSession],
    active_status: str,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value=active_status)
        run_id = run.id
        await append_run_event(session, run_id=run_id, event_type="run_started", payload={})
        result = await cancel_owned_run(session, user=user, run_id=run_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelling"
        assert updated.cancelled_at is None
        assert updated.completed_at is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == ["run_started"]


@pytest.mark.parametrize(
    ("terminal_status", "event_type"),
    [
        ("succeeded", "run_succeeded"),
        ("failed", "run_failed"),
        ("cancelled", "run_cancelled"),
    ],
)
async def test_cancel_owned_terminal_run_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
    terminal_status: str,
    event_type: RunEventType,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value=terminal_status)
        run_id = run.id
        await append_run_event(session, run_id=run_id, event_type=event_type, payload={})
        result = await cancel_owned_run(session, user=user, run_id=run_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == terminal_status

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == [event_type]


async def test_cancel_owned_cancelling_run_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        _, _, run = await create_run(session, user=user, status_value="cancelling")
        run_id = run.id
        result = await cancel_owned_run(session, user=user, run_id=run_id)
        await session.commit()

    assert result.status == "ok"

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "cancelling"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events == []


async def test_cancel_owned_run_cross_user_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        other_user = await create_user(session, "bob")
        _, _, run = await create_run(session, user=owner, status_value="streaming")

        with pytest.raises(AppError) as exc_info:
            await cancel_owned_run(session, user=other_user, run_id=run.id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"


async def test_cancel_owned_run_deleted_conversation_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, _, run = await create_run(session, user=user, status_value="streaming")
        conversation.deleted_at = datetime.now(UTC)
        await session.flush()

        with pytest.raises(AppError) as exc_info:
            await cancel_owned_run(session, user=user, run_id=run.id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Run not found"
```

- [ ] **Step 2: 运行 service 失败测试**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py::test_cancel_owned_queued_run_marks_cancelled_and_writes_terminal_event -v
```

Expected: FAIL，错误包含：

```text
ImportError: cannot import name 'cancel_owned_run'
```

- [ ] **Step 3: 运行全部新增 service 失败测试**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py -k cancel_owned -v
```

Expected: FAIL，错误仍来自 `cancel_owned_run` 尚未实现。

---

### Task 2: Runs service 取消实现

**Files:**
- Modify: `app/services/runs/service.py:1-149`
- Modify: `app/services/runs/__init__.py:12-41`
- Test: `tests/services/runs/test_run_service.py`

- [ ] **Step 1: 实现最小 service 逻辑**

把 `app/services/runs/service.py` 顶部 import 改为：

```python
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.conversation import Conversation
from app.models.run import Run, RunEvent
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.runs import RunEventResponse, RunEventType, RunStateResponse, RunStatus
```

在 `TERMINAL_EVENT_TYPES` 后加入取消状态常量：

```python
CANCEL_DIRECT_STATUSES = ("queued",)
CANCEL_REQUEST_STATUSES = ("started", "streaming")
CANCEL_IDEMPOTENT_STATUSES = ("cancelling", "succeeded", "failed", "cancelled")
```

在 `get_owned_visible_run()` 后、`append_run_event()` 前新增：

```python
async def cancel_owned_run(
    session: AsyncSession,
    *,
    user: User,
    run_id: int,
) -> CommandStatusResponse:
    run = await session.scalar(
        select(Run)
        .join(Conversation, Run.conversation_id == Conversation.id)
        .where(
            Run.id == run_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if run is None:
        raise AppError(status.HTTP_404_NOT_FOUND, RUN_NOT_FOUND_MESSAGE)

    if run.status in CANCEL_DIRECT_STATUSES:
        now = datetime.now(UTC)
        run.status = "cancelled"
        run.cancelled_at = now
        run.completed_at = now
        run.lease_owner = None
        run.lease_expires_at = None
        await session.flush()
        await append_run_event(
            session,
            run_id=run.id,
            event_type="run_cancelled",
            payload={},
        )
        return CommandStatusResponse()

    if run.status in CANCEL_REQUEST_STATUSES:
        run.status = "cancelling"
        await session.flush()
        return CommandStatusResponse()

    if run.status in CANCEL_IDEMPOTENT_STATUSES:
        return CommandStatusResponse()

    return CommandStatusResponse()
```

- [ ] **Step 2: 导出 service 函数**

把 `app/services/runs/__init__.py` 的 service import block 改为：

```python
from app.services.runs.service import (
    RUN_NOT_FOUND_MESSAGE,
    TERMINAL_EVENT_TYPES,
    append_run_event,
    cancel_owned_run,
    get_owned_run_state,
    get_owned_visible_run,
    list_owned_run_events_after,
    list_run_events_after,
    run_has_terminal_event,
)
```

并在 `__all__` 中把 `cancel_owned_run` 放在 `append_run_event` 后：

```python
__all__ = [
    "RUN_NOT_FOUND_MESSAGE",
    "TERMINAL_EVENT_TYPES",
    "append_run_event",
    "cancel_owned_run",
    "claim_next_queued_run",
    "get_owned_run_state",
    "get_owned_visible_run",
    "is_cancelling",
    "list_owned_run_events_after",
    "list_run_events_after",
    "mark_run_cancelled",
    "mark_run_failed",
    "mark_run_streaming",
    "mark_run_succeeded",
    "recover_expired_runs",
    "renew_lease",
    "run_has_terminal_event",
    "run_has_text_delta",
]
```

- [ ] **Step 3: 运行 service 测试确认通过**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py -k cancel_owned -v
```

Expected: PASS，输出包含：

```text
9 passed
```

- [ ] **Step 4: 运行 runs service 全量测试**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py tests/services/runs/test_lifecycle.py -v
```

Expected: PASS。

- [ ] **Step 5: 提交 service 层变更**

Run:

```bash
git add app/services/runs/service.py app/services/runs/__init__.py tests/services/runs/test_run_service.py
git commit -m "feat: add run cancellation service"
```

Expected: commit 成功，工作区仍可能有后续 API 测试文件未修改。

---

### Task 3: Run cancellation API 测试

**Files:**
- Modify: `tests/api/test_runs.py:383-end`

- [ ] **Step 1: 写入失败的 API 测试**

在 `tests/api/test_runs.py` 文件末尾追加：

```python
async def test_cancel_run_requires_authentication(client: AsyncClient) -> None:
    response = await client.post("/api/v1/runs/1/cancel")

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json() == {"detail": "Authentication required"}


async def test_cancel_queued_run_returns_ok_and_marks_cancelled(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-cancel-queued-api",
        email=f"alice-cancel-queued@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="queued",
        )
        run_id = run.id
        await session.commit()

    response = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"data": {"status": "ok"}}

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None
        assert run.completed_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == ["run_cancelled"]


async def test_cancel_streaming_run_returns_ok_and_marks_cancelling(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-cancel-streaming-api",
        email=f"alice-cancel-streaming@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="streaming",
        )
        await append_run_event(session, run_id=run.id, event_type="run_started", payload={})
        run_id = run.id
        await session.commit()

    response = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=headers)

    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"data": {"status": "ok"}}

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelling"
        assert run.cancelled_at is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == ["run_started"]


async def test_cancel_terminal_run_is_idempotent(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-cancel-terminal-api",
        email=f"alice-cancel-terminal@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="cancelled",
        )
        await append_run_event(session, run_id=run.id, event_type="run_cancelled", payload={})
        run_id = run.id
        await session.commit()

    first_response = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=headers)
    second_response = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=headers)

    assert first_response.status_code == status.HTTP_200_OK
    assert first_response.json() == {"data": {"status": "ok"}}
    assert second_response.status_code == status.HTTP_200_OK
    assert second_response.json() == {"data": {"status": "ok"}}

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [event.type for event in events] == ["run_cancelled"]


async def test_cross_user_cancel_run_returns_not_found(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-cancel-private-api",
        email=f"alice-cancel-private@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-cancel-private-api",
        email=f"bob-cancel-private@{TEST_EMAIL_DOMAIN}",
    )
    bob_headers = auth_headers(bob)

    async with session_factory() as session:
        run = await create_run_for_user(
            session,
            user_id=alice["user"]["id"],
            status_value="streaming",
        )
        run_id = run.id
        await session.commit()

    response = await client.post(f"/api/v1/runs/{run_id}/cancel", headers=bob_headers)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.json() == {"detail": "Run not found"}
```

- [ ] **Step 2: 运行 API 失败测试**

Run:

```bash
uv run pytest tests/api/test_runs.py::test_cancel_run_requires_authentication -v
```

Expected: FAIL，状态码是 `405 Method Not Allowed` 或 `404 Not Found`，因为 route 尚未实现。

- [ ] **Step 3: 运行所有新增 API 失败测试**

Run:

```bash
uv run pytest tests/api/test_runs.py -k cancel -v
```

Expected: FAIL，至少一个失败来自 cancel route 尚未实现。

---

### Task 4: Run cancellation API 实现

**Files:**
- Modify: `app/api/v1/runs.py:5-75`
- Test: `tests/api/test_runs.py`

- [ ] **Step 1: 更新 route imports**

把 `app/api/v1/runs.py` 的 schema imports 改为：

```python
from app.schemas.auth import CommandStatusResponse
from app.schemas.responses import SuccessResponse
from app.schemas.runs import RunEventResponse, RunStateResponse
```

把 runs service import block 改为：

```python
from app.services.runs.service import (
    TERMINAL_EVENT_TYPES,
    cancel_owned_run,
    get_owned_run_state,
    get_owned_visible_run,
    list_run_events_after,
    run_has_terminal_event,
)
```

- [ ] **Step 2: 添加 cancel route**

在 `get_run_state_route()` 后、`stream_run_events_route()` 前插入：

```python
@router.post(
    "/{run_id}/cancel",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def cancel_run_route(
    run_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CommandStatusResponse]:
    result = await cancel_owned_run(session, user=current_user, run_id=run_id)
    await session.commit()
    return SuccessResponse(data=result)
```

- [ ] **Step 3: 运行新增 API 测试确认通过**

Run:

```bash
uv run pytest tests/api/test_runs.py -k cancel -v
```

Expected: PASS，输出包含：

```text
5 passed
```

- [ ] **Step 4: 运行 runs API 全量测试**

Run:

```bash
uv run pytest tests/api/test_runs.py -v
```

Expected: PASS。

- [ ] **Step 5: 提交 API 层变更**

Run:

```bash
git add app/api/v1/runs.py tests/api/test_runs.py
git commit -m "feat: add run cancellation api"
```

Expected: commit 成功。

---

### Task 5: 全量验证

**Files:**
- Verify: whole repository

- [ ] **Step 1: 运行相关 service/API/worker 回归测试**

Run:

```bash
uv run pytest tests/services/runs/test_run_service.py tests/services/runs/test_lifecycle.py tests/api/test_runs.py tests/worker/test_executor.py -v
```

Expected: PASS。重点确认 worker 取消测试仍通过：

```text
test_execute_run_marks_cancelled_when_status_flips_during_stream PASSED
test_execute_run_cancels_blocked_provider_stream_promptly PASSED
```

- [ ] **Step 2: 运行全部测试**

Run:

```bash
uv run pytest -v
```

Expected: PASS。

- [ ] **Step 3: 运行 ruff**

Run:

```bash
uv run ruff check .
```

Expected:

```text
All checks passed!
```

- [ ] **Step 4: 运行 mypy**

Run:

```bash
uv run mypy .
```

Expected:

```text
Success: no issues found
```

- [ ] **Step 5: 确认 git 状态**

Run:

```bash
git status --short
```

Expected: 只允许出现本计划文档和已确认设计文档的未提交变更，或工作区为空。若执行者已经提交文档，则输出为空。

---

## 自查结果

- 规格覆盖：
  - `POST /api/v1/runs/{run_id}/cancel`：Task 3 和 Task 4。
  - ownership 和软删除隔离：Task 1 service 测试、Task 3 API 测试。
  - queued run 直接 `cancelled` 并写 `run_cancelled`：Task 1、Task 2、Task 3。
  - started/streaming run 置为 `cancelling`：Task 1、Task 2、Task 3。
  - cancelling 和 terminal 幂等：Task 1、Task 2、Task 3。
  - 不调用 provider、不拥有 HTTP stream 生命周期：Task 2 仅写数据库状态，Task 4 route 只调用 service。
- 占位符扫描：计划中没有待补内容；每个代码变更步骤都给出具体代码。
- 类型一致性：
  - service 函数名统一为 `cancel_owned_run`。
  - route 函数名统一为 `cancel_run_route`。
  - 响应类型统一为 `SuccessResponse[CommandStatusResponse]`。
  - event 类型复用现有 `RunEventType` literal。
