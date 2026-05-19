# Regenerate 实现计划

> **给 agentic workers：** 必须使用子技能：实现本计划时使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 在现有聊天功能上新增两条交互入口——编辑某条 user message 并重生（edit-and-regenerate），以及为某条 assistant message 重新生成回复（regenerate-only）。两者共享同一套"按 position 截断 → 创建新 run → notify worker"语义。

**架构：** API handler 保持 thin，只做认证 + 调用 service + commit。截断与新 run 创建放在 `app/services/conversations/service.py`，新增两个对外函数 `edit_user_message_and_regenerate` 与 `regenerate_from_message`，复用现有 `ensure_no_active_run`、`get_next_message_position`、`pg_notify('runs_queued', …)`。无 schema 迁移，仅使用既有 `messages.archived_at`。worker / SSE / provider 完全不动。

**技术栈：** Python 3.12、FastAPI、SQLAlchemy 2.0 async、PostgreSQL 16、pytest（asyncio_mode=auto，挂真库）、ruff、mypy、Node test runner（前端）。

参考设计：[`docs/superpowers/specs/2026-05-19-regenerate-design.md`](../specs/2026-05-19-regenerate-design.md)。

---

## 文件结构

- 修改 `app/services/conversations/service.py`
  - 新增 message 错误信息常量。
  - 新增私有辅助 `_archive_messages_at_or_after_position` 和 `_archive_messages_after_position`。
  - 新增 `edit_user_message_and_regenerate(...)` 与 `regenerate_from_message(...)`。
- 修改 `app/services/conversations/__init__.py`
  - 导出两个新函数。
- 修改 `app/api/v1/conversations.py`
  - 新增 `POST /api/v1/conversations/{conversation_id}/messages/{message_id}/edit-and-regenerate`。
  - 新增 `POST /api/v1/conversations/{conversation_id}/messages/{message_id}/regenerate`。
- 创建 `tests/services/conversations/test_regenerate.py`
  - service 层 happy path + 错误路径覆盖。
- 修改 `tests/api/test_conversations.py`
  - 新增两个端点的集成测试。
- 修改 `frontend/api.js`
  - `conversations.editAndRegenerate(token, conversationId, messageId, content)`。
  - `conversations.regenerate(token, conversationId, messageId)`。
- 修改 `frontend/views/chat.js`
  - 在 `renderMessage` 的 actions 区追加"编辑"按钮（user）与"重新生成"按钮（assistant）。
  - 编辑用 inline textarea，确认后调 API；重生直接调 API。
  - 两个按钮在 `activeRun` 存在时禁用。
- 修改 `frontend/views/chat.test.js`
  - 加 source-pattern 测试断言按钮存在。
- 修改 `docs/architecture/overview.md`
  - 删除「已知边界」中的 `regenerate：未实现`。
- 创建 `docs/handover/2026-05-19-regenerate.md`
  - 实现纪录与验证命令。

不新增数据库迁移，不修改 worker / provider / SSE 任何代码，不引入新的 Pydantic 请求模型（edit 端点复用现有 `MessageCreateRequest`，regenerate 端点无请求体）。

---

### Task 1: edit_user_message_and_regenerate — service 测试

**Files:**
- Create: `tests/services/conversations/test_regenerate.py`

- [ ] **Step 1: 创建测试文件骨架**

写入 `tests/services/conversations/test_regenerate.py`：

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
from app.services.conversations.service import (
    edit_user_message_and_regenerate,
    regenerate_from_message,
)

TEST_DATABASE_URL = os.environ.get(
    "REGENERATE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "regenerate-service-test.example.com"


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


async def seed_conversation_with_turns(
    session: AsyncSession, *, user: User
) -> tuple[Conversation, list[Message], list[Run]]:
    """Build a conversation with two completed turns:
    user(p1) -> assistant(p2), user(p3) -> assistant(p4).
    Each turn has a succeeded run; all runs are terminal so no active run blocks.
    """
    conversation = Conversation(user_id=user.id, title="Project chat")
    session.add(conversation)
    await session.flush()

    messages: list[Message] = []
    runs: list[Run] = []
    for turn_index in range(2):
        user_position = turn_index * 2 + 1
        assistant_position = user_position + 1

        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content=f"user-turn-{turn_index}",
            position=user_position,
        )
        session.add(user_message)
        await session.flush()

        run = Run(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="deepseek",
            provider_model="deepseek-chat",
            completed_at=datetime.now(UTC),
        )
        session.add(run)
        await session.flush()
        user_message.run_id = run.id

        assistant_message = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content=f"assistant-turn-{turn_index}",
            position=assistant_position,
        )
        session.add(assistant_message)
        await session.flush()

        messages.extend([user_message, assistant_message])
        runs.append(run)

    return conversation, messages, runs
```

- [ ] **Step 2: 追加 edit-and-regenerate happy-path 测试**

继续追加到 `tests/services/conversations/test_regenerate.py`：

```python
async def test_edit_user_message_archives_target_and_inserts_new_message_and_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        target = messages[2]  # user message at position 3
        assistant_after = messages[3]  # assistant at position 4
        user_message_id_before_edit = target.id

        result = await edit_user_message_and_regenerate(
            session,
            user=user,
            conversation_id=conversation.id,
            message_id=target.id,
            new_content="updated user text",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    async with session_factory() as session:
        kept_first_user = await session.get(Message, messages[0].id)
        kept_first_assistant = await session.get(Message, messages[1].id)
        archived_target = await session.get(Message, user_message_id_before_edit)
        archived_assistant = await session.get(Message, assistant_after.id)
        new_message = await session.get(Message, result.message.id)
        new_run = await session.get(Run, result.run.id)

    assert kept_first_user is not None and kept_first_user.archived_at is None
    assert kept_first_assistant is not None and kept_first_assistant.archived_at is None
    assert archived_target is not None and archived_target.archived_at is not None
    assert archived_target.content == "user-turn-1"  # original content preserved
    assert archived_assistant is not None and archived_assistant.archived_at is not None

    assert new_message is not None
    assert new_message.role == "user"
    assert new_message.content == "updated user text"
    assert new_message.position == 5  # MAX(position)+1 over all rows, archived included
    assert new_message.archived_at is None
    assert new_message.run_id == result.run.id

    assert new_run is not None
    assert new_run.status == "queued"
    assert new_run.user_message_id == new_message.id
    assert new_run.provider_name == "deepseek"
    assert new_run.provider_model == "deepseek-chat"
```

- [ ] **Step 3: 追加 edit-and-regenerate 错误路径测试**

继续追加：

```python
async def test_edit_rejects_assistant_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        assistant_message = messages[1]

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=user,
                conversation_id=conversation.id,
                message_id=assistant_message.id,
                new_content="nope",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Edit target must be a user message"


async def test_edit_rejects_archived_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        messages[0].archived_at = datetime.now(UTC)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=user,
                conversation_id=conversation.id,
                message_id=messages[0].id,
                new_content="changed",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Message not found"


async def test_edit_rejects_cross_user_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        intruder = await create_user(session, "bob")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=owner)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=intruder,
                conversation_id=conversation.id,
                message_id=messages[2].id,
                new_content="changed",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_edit_rejects_when_active_run_exists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        # Inject a queued run for the latest turn, simulating an in-flight generation.
        active = Run(
            conversation_id=conversation.id,
            user_message_id=messages[2].id,
            status="queued",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(active)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await edit_user_message_and_regenerate(
                session,
                user=user,
                conversation_id=conversation.id,
                message_id=messages[0].id,
                new_content="changed",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Active run already exists"
```

- [ ] **Step 4: 跑测试确认 FAIL（函数尚未实现）**

```bash
docker compose exec api pytest tests/services/conversations/test_regenerate.py -v
```

预期：`ImportError: cannot import name 'edit_user_message_and_regenerate' from 'app.services.conversations.service'`。这是预期的 RED 阶段。

- [ ] **Step 5: 提交失败测试（可选，便于 review）**

```bash
git add tests/services/conversations/test_regenerate.py
git commit -m "test(conversations): failing tests for edit_user_message_and_regenerate"
```

---

### Task 2: 实现 edit_user_message_and_regenerate

**Files:**
- Modify: `app/services/conversations/service.py`

- [ ] **Step 1: 引入新依赖 + 常量**

在 `app/services/conversations/service.py` 顶部，把 `from sqlalchemy import func, select, text` 改为：

```python
from sqlalchemy import func, select, text, update
```

并在文件常量区追加：

```python
MESSAGE_NOT_FOUND_MESSAGE = "Message not found"
EDIT_TARGET_NOT_USER_MESSAGE = "Edit target must be a user message"
CANNOT_RESOLVE_USER_MESSAGE = "Cannot resolve user message to regenerate from"
```

- [ ] **Step 2: 新增私有辅助函数**

在文件末尾、`normalize_optional_title` 之前追加：

```python
async def _archive_messages_at_or_after_position(
    session: AsyncSession,
    *,
    conversation_id: int,
    position: int,
) -> None:
    now = await get_database_now(session)
    await session.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.position >= position,
            Message.archived_at.is_(None),
        )
        .values(archived_at=now)
    )


async def _archive_messages_after_position(
    session: AsyncSession,
    *,
    conversation_id: int,
    position: int,
) -> None:
    now = await get_database_now(session)
    await session.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.position > position,
            Message.archived_at.is_(None),
        )
        .values(archived_at=now)
    )


async def _get_owned_unarchived_message_for_update(
    session: AsyncSession,
    *,
    conversation_id: int,
    message_id: int,
) -> Message:
    message = await session.scalar(
        select(Message)
        .where(
            Message.id == message_id,
            Message.conversation_id == conversation_id,
            Message.archived_at.is_(None),
        )
        .with_for_update()
    )
    if message is None:
        raise AppError(status.HTTP_404_NOT_FOUND, MESSAGE_NOT_FOUND_MESSAGE)
    return message
```

- [ ] **Step 3: 实现 edit_user_message_and_regenerate**

在 `submit_user_message` 之后追加：

```python
async def edit_user_message_and_regenerate(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
    message_id: int,
    new_content: str,
    provider_name: str,
    provider_model: str,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    target = await _get_owned_unarchived_message_for_update(
        session,
        conversation_id=conversation.id,
        message_id=message_id,
    )
    if target.role != "user":
        raise AppError(status.HTTP_409_CONFLICT, EDIT_TARGET_NOT_USER_MESSAGE)

    await ensure_no_active_run(session, conversation_id=conversation.id)
    await _archive_messages_at_or_after_position(
        session,
        conversation_id=conversation.id,
        position=target.position,
    )

    next_position = await get_next_message_position(session, conversation_id=conversation.id)
    new_message = Message(
        conversation_id=conversation.id,
        role="user",
        content=new_content,
        position=next_position,
    )
    session.add(new_message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=new_message.id,
        status="queued",
        provider_name=provider_name,
        provider_model=provider_model,
    )
    session.add(run)
    await session.flush()

    new_message.run_id = run.id
    conversation.updated_at = await get_database_now(session)
    await session.flush()

    await session.execute(
        text("SELECT pg_notify('runs_queued', :payload)"),
        {"payload": str(run.id)},
    )

    return SendMessageResponse(
        message=message_response(new_message),
        run=run_response(run),
    )
```

- [ ] **Step 4: 跑测试确认 PASS**

```bash
docker compose exec api pytest tests/services/conversations/test_regenerate.py -v
```

预期：所有 5 个 edit_* 测试 PASS。

- [ ] **Step 5: lint + type check**

```bash
docker compose exec api ruff check app tests
docker compose exec api mypy app
```

预期：两条命令都退出 0。

- [ ] **Step 6: 提交**

```bash
git add app/services/conversations/service.py tests/services/conversations/test_regenerate.py
git commit -m "feat(conversations): edit_user_message_and_regenerate service"
```

---

### Task 3: regenerate_from_message — service 测试

**Files:**
- Modify: `tests/services/conversations/test_regenerate.py`

- [ ] **Step 1: 追加 happy-path 测试（user message 作为锚点）**

在 `test_regenerate.py` 末尾追加：

```python
async def test_regenerate_from_user_message_archives_following_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        anchor = messages[2]  # user at position 3
        assistant_after = messages[3]
        first_user = messages[0]
        first_assistant = messages[1]

        result = await regenerate_from_message(
            session,
            user=user,
            conversation_id=conversation.id,
            message_id=anchor.id,
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    async with session_factory() as session:
        anchor_after = await session.get(Message, anchor.id)
        assistant_archived = await session.get(Message, assistant_after.id)
        kept_user = await session.get(Message, first_user.id)
        kept_assistant = await session.get(Message, first_assistant.id)
        new_run = await session.get(Run, result.run.id)

    assert anchor_after is not None and anchor_after.archived_at is None
    assert kept_user is not None and kept_user.archived_at is None
    assert kept_assistant is not None and kept_assistant.archived_at is None
    assert assistant_archived is not None and assistant_archived.archived_at is not None

    # No new message inserted; reply will materialize when worker runs.
    assert result.message.id == anchor.id
    assert new_run is not None
    assert new_run.status == "queued"
    assert new_run.user_message_id == anchor.id
```

- [ ] **Step 2: 追加 happy-path 测试（assistant message 作为锚点，反查 user）**

继续追加：

```python
async def test_regenerate_from_assistant_message_resolves_to_parent_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        target_assistant = messages[3]  # assistant at position 4
        expected_user_anchor = messages[2]

        result = await regenerate_from_message(
            session,
            user=user,
            conversation_id=conversation.id,
            message_id=target_assistant.id,
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    async with session_factory() as session:
        anchor_after = await session.get(Message, expected_user_anchor.id)
        assistant_archived = await session.get(Message, target_assistant.id)
        new_run = await session.get(Run, result.run.id)

    assert anchor_after is not None and anchor_after.archived_at is None
    assert assistant_archived is not None and assistant_archived.archived_at is not None
    assert new_run is not None
    assert new_run.user_message_id == expected_user_anchor.id
    assert result.message.id == expected_user_anchor.id
```

- [ ] **Step 3: 追加错误路径测试**

继续追加：

```python
async def test_regenerate_rejects_assistant_without_run_id(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        messages[3].run_id = None  # corrupt the link
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=user,
                conversation_id=conversation.id,
                message_id=messages[3].id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Cannot resolve user message to regenerate from"


async def test_regenerate_rejects_archived_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        messages[3].archived_at = datetime.now(UTC)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=user,
                conversation_id=conversation.id,
                message_id=messages[3].id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Message not found"


async def test_regenerate_rejects_cross_user_target(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        intruder = await create_user(session, "bob")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=owner)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=intruder,
                conversation_id=conversation.id,
                message_id=messages[3].id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_regenerate_rejects_when_active_run_exists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation, messages, _runs = await seed_conversation_with_turns(session, user=user)
        active = Run(
            conversation_id=conversation.id,
            user_message_id=messages[2].id,
            status="streaming",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(active)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await regenerate_from_message(
                session,
                user=user,
                conversation_id=conversation.id,
                message_id=messages[3].id,
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Active run already exists"
```

- [ ] **Step 4: 跑测试确认 FAIL**

```bash
docker compose exec api pytest tests/services/conversations/test_regenerate.py -v -k regenerate_from
```

预期：6 个 regenerate_from_* 测试 FAIL，import 也 FAIL（`regenerate_from_message` 未定义）。

---

### Task 4: 实现 regenerate_from_message

**Files:**
- Modify: `app/services/conversations/service.py`

- [ ] **Step 1: 实现函数**

在 `edit_user_message_and_regenerate` 之后追加：

```python
async def regenerate_from_message(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
    message_id: int,
    provider_name: str,
    provider_model: str,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    target = await _get_owned_unarchived_message_for_update(
        session,
        conversation_id=conversation.id,
        message_id=message_id,
    )

    if target.role == "assistant":
        if target.run_id is None:
            raise AppError(status.HTTP_409_CONFLICT, CANNOT_RESOLVE_USER_MESSAGE)
        target_run = await session.get(Run, target.run_id)
        if target_run is None:
            raise AppError(status.HTTP_409_CONFLICT, CANNOT_RESOLVE_USER_MESSAGE)
        anchor = await _get_owned_unarchived_message_for_update(
            session,
            conversation_id=conversation.id,
            message_id=target_run.user_message_id,
        )
        if anchor.role != "user":
            raise AppError(status.HTTP_409_CONFLICT, CANNOT_RESOLVE_USER_MESSAGE)
    else:
        anchor = target

    await ensure_no_active_run(session, conversation_id=conversation.id)
    await _archive_messages_after_position(
        session,
        conversation_id=conversation.id,
        position=anchor.position,
    )

    run = Run(
        conversation_id=conversation.id,
        user_message_id=anchor.id,
        status="queued",
        provider_name=provider_name,
        provider_model=provider_model,
    )
    session.add(run)
    await session.flush()

    conversation.updated_at = await get_database_now(session)
    await session.flush()

    await session.execute(
        text("SELECT pg_notify('runs_queued', :payload)"),
        {"payload": str(run.id)},
    )

    return SendMessageResponse(
        message=message_response(anchor),
        run=run_response(run),
    )
```

- [ ] **Step 2: 跑测试确认 PASS**

```bash
docker compose exec api pytest tests/services/conversations/test_regenerate.py -v
```

预期：所有 9 个测试 PASS。

- [ ] **Step 3: lint + type check**

```bash
docker compose exec api ruff check app tests
docker compose exec api mypy app
```

预期：两条命令退出 0。

- [ ] **Step 4: 提交**

```bash
git add app/services/conversations/service.py tests/services/conversations/test_regenerate.py
git commit -m "feat(conversations): regenerate_from_message service"
```

---

### Task 5: 导出新 service 函数

**Files:**
- Modify: `app/services/conversations/__init__.py`

- [ ] **Step 1: 修改 __init__.py**

把现有内容替换为：

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    edit_user_message_and_regenerate,
    get_conversation_detail,
    list_conversations,
    materialize_assistant_message,
    regenerate_from_message,
    rename_conversation,
    submit_user_message,
)

__all__ = [
    "create_conversation",
    "delete_conversation",
    "edit_user_message_and_regenerate",
    "get_conversation_detail",
    "list_conversations",
    "materialize_assistant_message",
    "regenerate_from_message",
    "rename_conversation",
    "submit_user_message",
]
```

- [ ] **Step 2: 跑测试与 lint**

```bash
docker compose exec api pytest tests/services/conversations -v
docker compose exec api ruff check app tests
docker compose exec api mypy app
```

预期：全部通过。

- [ ] **Step 3: 提交**

```bash
git add app/services/conversations/__init__.py
git commit -m "feat(conversations): export regenerate service entrypoints"
```

---

### Task 6: API 路由 — 集成测试

**Files:**
- Modify: `tests/api/test_conversations.py`

- [ ] **Step 1: 在文件末尾追加集成测试**

在 `tests/api/test_conversations.py` 末尾追加：

```python
async def seed_completed_turn(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_email: str,
) -> dict[str, int]:
    """Insert a finished turn (user + assistant + succeeded run) for the user.

    Returns the ids of conversation, user_message, assistant_message.
    """
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == user_email))
        assert user is not None, "register_user must run before seed_completed_turn"
        conversation = Conversation(user_id=user.id, title="seeded")
        session.add(conversation)
        await session.flush()

        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content="hello",
            position=1,
        )
        session.add(user_message)
        await session.flush()

        run = Run(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(run)
        await session.flush()
        user_message.run_id = run.id

        assistant_message = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content="world",
            position=2,
        )
        session.add(assistant_message)
        await session.commit()

        return {
            "conversation_id": conversation.id,
            "user_message_id": user_message.id,
            "assistant_message_id": assistant_message.id,
        }


async def test_edit_and_regenerate_endpoint_creates_new_message_and_run(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-edit-regen",
        email=f"alice-edit@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-edit@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['user_message_id']}/edit-and-regenerate",
        json={"content": "rewritten"},
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()["data"]
    assert body["message"]["role"] == "user"
    assert body["message"]["content"] == "rewritten"
    assert body["message"]["id"] != seeded["user_message_id"]
    assert body["run"]["status"] == "queued"

    async with session_factory() as session:
        old_user = await session.get(Message, seeded["user_message_id"])
        old_assistant = await session.get(Message, seeded["assistant_message_id"])
        assert old_user is not None and old_user.archived_at is not None
        assert old_assistant is not None and old_assistant.archived_at is not None


async def test_regenerate_endpoint_reuses_user_message_for_assistant_target(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-regen",
        email=f"alice-regen@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-regen@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['assistant_message_id']}/regenerate",
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_201_CREATED
    body = response.json()["data"]
    assert body["message"]["id"] == seeded["user_message_id"]
    assert body["run"]["status"] == "queued"
    assert body["run"]["user_message_id"] == seeded["user_message_id"]

    async with session_factory() as session:
        anchor = await session.get(Message, seeded["user_message_id"])
        archived_assistant = await session.get(Message, seeded["assistant_message_id"])
        assert anchor is not None and anchor.archived_at is None
        assert archived_assistant is not None and archived_assistant.archived_at is not None


async def test_edit_and_regenerate_rejects_cross_user(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await register_user(
        client,
        username="alice-cross",
        email=f"alice-cross@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-cross",
        email=f"bob-cross@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-cross@{TEST_EMAIL_DOMAIN}"
    )

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['user_message_id']}/edit-and-regenerate",
        json={"content": "intrusion"},
        headers=auth_headers(bob),
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


async def test_regenerate_endpoint_conflicts_with_active_run(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    alice = await register_user(
        client,
        username="alice-active",
        email=f"alice-active@{TEST_EMAIL_DOMAIN}",
    )
    seeded = await seed_completed_turn(
        session_factory, user_email=f"alice-active@{TEST_EMAIL_DOMAIN}"
    )

    async with session_factory() as session:
        session.add(
            Run(
                conversation_id=seeded["conversation_id"],
                user_message_id=seeded["user_message_id"],
                status="queued",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )
        )
        await session.commit()

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['assistant_message_id']}/regenerate",
        headers=auth_headers(alice),
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert response.json()["detail"] == "Active run already exists"
```

- [ ] **Step 2: 跑测试确认 FAIL**

```bash
docker compose exec api pytest tests/api/test_conversations.py -v -k "edit_and_regenerate or regenerate_endpoint"
```

预期：4 个新测试 FAIL（路由 404）。

---

### Task 7: 实现 API 路由

**Files:**
- Modify: `app/api/v1/conversations.py`

- [ ] **Step 1: 调整 import**

把 conversations.py 顶部的服务函数 import 改为：

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    edit_user_message_and_regenerate,
    get_conversation_detail,
    list_conversations,
    regenerate_from_message,
    rename_conversation,
    submit_user_message,
)
```

- [ ] **Step 2: 在 `send_message_route` 之后追加两个新 route**

在 `app/api/v1/conversations.py` 文件末尾追加：

```python
@router.post(
    "/{conversation_id}/messages/{message_id}/edit-and-regenerate",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def edit_and_regenerate_route(
    conversation_id: int,
    message_id: int,
    request: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[SendMessageResponse]:
    result = await edit_user_message_and_regenerate(
        session,
        user=current_user,
        conversation_id=conversation_id,
        message_id=message_id,
        new_content=request.content,
        provider_name="deepseek",
        provider_model=settings.deepseek_model,
    )
    await session.commit()
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages/{message_id}/regenerate",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def regenerate_route(
    conversation_id: int,
    message_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[SendMessageResponse]:
    result = await regenerate_from_message(
        session,
        user=current_user,
        conversation_id=conversation_id,
        message_id=message_id,
        provider_name="deepseek",
        provider_model=settings.deepseek_model,
    )
    await session.commit()
    return SuccessResponse(data=result)
```

- [ ] **Step 3: 跑测试确认 PASS**

```bash
docker compose exec api pytest tests/api/test_conversations.py -v
```

预期：全文件 PASS。

- [ ] **Step 4: lint + type check**

```bash
docker compose exec api ruff check app tests
docker compose exec api mypy app
```

预期：退出 0。

- [ ] **Step 5: 提交**

```bash
git add app/api/v1/conversations.py tests/api/test_conversations.py
git commit -m "feat(api): edit-and-regenerate + regenerate endpoints"
```

---

### Task 8: 前端 api.js — 加 2 个调用

**Files:**
- Modify: `frontend/api.js`

- [ ] **Step 1: 在 `conversations` 对象里加方法**

把 `export const conversations = { ... }` 整段替换为：

```javascript
export const conversations = {
  list: (token) => request("/conversations", { token }),
  create: (token, title) => request("/conversations", { method: "POST", token, body: { title: title ?? null } }),
  detail: (token, id) => request(`/conversations/${id}`, { token }),
  rename: (token, id, title) => request(`/conversations/${id}`, { method: "PATCH", token, body: { title } }),
  remove: (token, id) => request(`/conversations/${id}`, { method: "DELETE", token }),
  sendMessage: (token, id, content) =>
    request(`/conversations/${id}/messages`, { method: "POST", token, body: { content } }),
  editAndRegenerate: (token, conversationId, messageId, content) =>
    request(
      `/conversations/${conversationId}/messages/${messageId}/edit-and-regenerate`,
      { method: "POST", token, body: { content } },
    ),
  regenerate: (token, conversationId, messageId) =>
    request(
      `/conversations/${conversationId}/messages/${messageId}/regenerate`,
      { method: "POST", token },
    ),
};
```

- [ ] **Step 2: 跑前端测试**

```bash
node --test frontend/views/chat.test.js
```

预期：现有测试不破，仍然全 PASS。

- [ ] **Step 3: 提交**

```bash
git add frontend/api.js
git commit -m "feat(frontend): api.js helpers for regenerate endpoints"
```

---

### Task 9: 前端 UI — 编辑 + 重新生成按钮

**Files:**
- Modify: `frontend/views/chat.js`
- Modify: `frontend/views/chat.test.js`

- [ ] **Step 1: 替换 `renderMessage` 中 `actions` 那段**

定位 `frontend/views/chat.js` 中的：

```javascript
  const actions = el("div", {
    class: `message-actions flex ${isUser ? "justify-end" : "justify-start"} px-1`,
  }, [buildCopyButton(message.content)]);
```

替换为：

```javascript
  const actionButtons = [buildCopyButton(message.content)];
  if (typeof message.id === "number") {
    if (isUser) {
      actionButtons.push(buildEditButton(message));
    } else {
      actionButtons.push(buildRegenerateButton(message));
    }
  }
  const actions = el("div", {
    class: `message-actions flex ${isUser ? "justify-end" : "justify-start"} px-1`,
  }, actionButtons);
```

`typeof message.id === "number"` 把流式 placeholder（id 形如 `"pending-..."`）排除掉。

- [ ] **Step 2: 加 buildEditButton / buildRegenerateButton / 编辑面板**

紧接在 `buildCopyButton` 函数之后追加：

```javascript
function buildEditButton(message) {
  const { activeRun } = getState();
  const disabled = Boolean(activeRun);
  const button = el("button", {
    type: "button",
    class: "message-edit-button inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50",
    title: disabled ? "请先停止当前生成" : "编辑并重新生成",
    "aria-label": "Edit and regenerate",
    onClick: (event) => {
      event.stopPropagation();
      startEditingUserMessage(message);
    },
  }, ["编辑"]);
  if (disabled) button.disabled = true;
  return button;
}

function buildRegenerateButton(message) {
  const { activeRun } = getState();
  const disabled = Boolean(activeRun);
  const button = el("button", {
    type: "button",
    class: "message-regenerate-button inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50",
    title: disabled ? "请先停止当前生成" : "重新生成",
    "aria-label": "Regenerate",
    onClick: (event) => {
      event.stopPropagation();
      void triggerRegenerate(message);
    },
  }, ["重新生成"]);
  if (disabled) button.disabled = true;
  return button;
}

function startEditingUserMessage(message) {
  const detail = getState().detail;
  if (!detail) return;
  const bubble = document.querySelector(
    `[data-message-id="${message.id}"][data-role="user"]`,
  );
  if (!bubble) return;

  const original = message.content;
  const textarea = el("textarea", {
    rows: "3",
    class: "w-full min-h-[3rem] resize-y border border-zinc-300 rounded-md px-3 py-2 text-base sm:text-sm outline-none focus:border-zinc-500 bg-white",
  });
  textarea.value = original;

  const confirmButton = el("button", {
    type: "button",
    class: "h-7 px-2 rounded-md bg-zinc-900 text-white text-xs hover:bg-zinc-800 disabled:opacity-50",
  }, ["保存并重生"]);
  const cancelButton = el("button", {
    type: "button",
    class: "h-7 px-2 rounded-md border border-zinc-200 text-xs text-zinc-600 hover:bg-zinc-100",
  }, ["取消"]);
  const buttonRow = el("div", { class: "mt-2 flex gap-2 justify-end" }, [cancelButton, confirmButton]);
  const editor = el("div", { class: "w-full" }, [textarea, buttonRow]);
  bubble.replaceWith(editor);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  cancelButton.addEventListener("click", () => { rerenderMain(); });
  confirmButton.addEventListener("click", async () => {
    const next = textarea.value.trim();
    if (!next) { toast("内容不能为空", "error"); return; }
    if (next === original) { rerenderMain(); return; }
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    try {
      const { run } = await withAuth((t) =>
        api.conversations.editAndRegenerate(t, detail.id, message.id, next),
      );
      const refreshed = await withAuth((t) => api.conversations.detail(t, detail.id));
      if (getState().selectedId === detail.id) setState({ detail: refreshed });
      void attachRunStream({ conversationId: detail.id, runId: run.id, afterSeq: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast("当前对话有生成进行中，请先停止后再试", "error");
      } else {
        toast(errorMessage(err, "编辑失败"), "error");
      }
      rerenderMain();
    }
  });
}

async function triggerRegenerate(message) {
  const detail = getState().detail;
  if (!detail) return;
  try {
    const { run } = await withAuth((t) =>
      api.conversations.regenerate(t, detail.id, message.id),
    );
    const refreshed = await withAuth((t) => api.conversations.detail(t, detail.id));
    if (getState().selectedId === detail.id) setState({ detail: refreshed });
    void attachRunStream({ conversationId: detail.id, runId: run.id, afterSeq: 0 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      toast("当前对话有生成进行中，请先停止后再试", "error");
    } else {
      toast(errorMessage(err, "重新生成失败"), "error");
    }
  }
}
```

- [ ] **Step 3: 加前端 source-pattern 测试**

在 `frontend/views/chat.test.js` 末尾追加：

```javascript
test("user messages expose an edit-and-regenerate affordance", () => {
  assert.match(chatSource, /buildEditButton\(message\)/);
  assert.match(chatSource, /message-edit-button/);
  assert.match(chatSource, /editAndRegenerate\(t, detail\.id, message\.id, next\)/);
});

test("assistant messages expose a regenerate affordance", () => {
  assert.match(chatSource, /buildRegenerateButton\(message\)/);
  assert.match(chatSource, /message-regenerate-button/);
  assert.match(chatSource, /api\.conversations\.regenerate\(t, detail\.id, message\.id\)/);
});

test("edit and regenerate actions are disabled while a run is active", () => {
  assert.match(chatSource, /buildEditButton[\s\S]{0,200}disabled\s*=\s*Boolean\(activeRun\)/);
  assert.match(chatSource, /buildRegenerateButton[\s\S]{0,200}disabled\s*=\s*Boolean\(activeRun\)/);
});
```

- [ ] **Step 4: 跑前端测试**

```bash
node --test frontend/views/chat.test.js
```

预期：所有测试 PASS（含新加的 3 个）。

- [ ] **Step 5: 手动 smoke（本地浏览器）**

```bash
docker compose up -d
```

打开 `http://localhost:8000`，登录后：

1. 发一条消息，等回复完成。
2. 在该 user message 上点"编辑"，改文本后保存——视图刷新，旧 user/assistant 消失，新 user + 新 assistant 流出现。
3. 在 assistant 上点"重新生成"——user 不变，旧 assistant 消失，新 assistant 流出现。
4. 在新一轮还在 streaming 时观察按钮：均 disabled 且 hover 提示"请先停止当前生成"。
5. 在 streaming 时强行调 API（开发者工具）应得到 409。

- [ ] **Step 6: 提交**

```bash
git add frontend/views/chat.js frontend/views/chat.test.js
git commit -m "feat(frontend): edit-and-regenerate + regenerate UI"
```

---

### Task 10: 文档更新

**Files:**
- Modify: `docs/architecture/overview.md`
- Create: `docs/handover/2026-05-19-regenerate.md`

- [ ] **Step 1: 从 overview 的「已知边界」中删除 regenerate 条目**

把 `docs/architecture/overview.md` 第 254 行附近：

```
- Conversation branch / Last-Event-ID / regenerate：未实现。
```

改为：

```
- Conversation branch / Last-Event-ID：未实现。
```

- [ ] **Step 2: 写 handover 文档**

写入 `docs/handover/2026-05-19-regenerate.md`：

```markdown
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
- `tests/services/conversations/test_regenerate.py`：service 层 9 个测试。
- `tests/api/test_conversations.py`：4 个集成测试（happy path + cross-user + active-run conflict）。
- `frontend/api.js`：`conversations.editAndRegenerate`、`conversations.regenerate`。
- `frontend/views/chat.js`：`buildEditButton`、`buildRegenerateButton`、`startEditingUserMessage`、`triggerRegenerate`。

## 设计要点回顾

- 截断用 `messages.archived_at`；不删数据，留审计。
- `runs.user_message_id` 没有 unique 约束，regenerate-only 让多个 run 复用同一 user_message_id 是允许的。
- 老 run 的 `run_events` 保留；前端不再展示其 message 因为已 archive。
- active run 冲突走现有 `ensure_no_active_run`，返回 409。后端不自动 cancel。
- `materialize_assistant_message` 使用 `MAX(position) + 1`，archive 不影响 position 单调性，因此 worker 完成新 run 后写入的 assistant 自然在最高 position。

## 验证

```bash
# 起服务
docker compose up -d

# Service 测试
docker compose exec api pytest tests/services/conversations/test_regenerate.py -v

# API 测试
docker compose exec api pytest tests/api/test_conversations.py -v

# 全套
docker compose exec api pytest
docker compose exec api ruff check app tests
docker compose exec api mypy app
node --test frontend/views/chat.test.js
```

## 已知局限

- 不引入分支树；视图只见最新版本。
- regenerate 端点接受 assistant message id 时，如果该 assistant 的 `run_id` 已被某种异常清空，会返回 409；正常数据不会触发。
- 大体积归档（一次性 archive 数百条消息）目前是单条 UPDATE，未做分页或后台处理；对现在的对话规模无影响。
```

- [ ] **Step 3: 提交**

```bash
git add docs/architecture/overview.md docs/handover/2026-05-19-regenerate.md
git commit -m "docs: regenerate handover and overview update"
```

---

### Task 11: 最终全套验证

**Files:** 无

- [ ] **Step 1: 起栈**

```bash
docker compose up -d
docker compose ps
```

预期：api、worker、postgres 三个服务都 healthy。

- [ ] **Step 2: 全套后端测试**

```bash
docker compose exec api pytest
```

预期：全部 PASS。

- [ ] **Step 3: lint + type check**

```bash
docker compose exec api ruff check app tests
docker compose exec api mypy app
```

预期：退出 0。

- [ ] **Step 4: 前端测试**

```bash
node --test frontend/views/chat.test.js
```

预期：全部 PASS。

- [ ] **Step 5: 手动 smoke（如 Task 9 Step 5）**

走一遍：编辑历史 user message、对 assistant message 重新生成、active-run 期间按钮 disabled、强行调 API 得到 409。

确认无 regression 后本计划完成。

---

## Self-review 备注（计划作者自检）

- Spec 覆盖：
  - 2.1 Edit-and-regenerate → Task 1–2 + Task 7。
  - 2.2 Regenerate-only（user / assistant 两种锚点）→ Task 3–4 + Task 7。
  - 错误码 404/409/422 → Task 1/3 service 测试 + Task 6 API 测试。
  - 公共前置条件（archive 校验、active run、ownership）→ Task 1/3 测试用例。
  - 前端按钮 + active-run disable → Task 9。
  - 文档同步（overview / handover）→ Task 10。
- 类型一致性：service 函数返回 `SendMessageResponse`，路由用 `SuccessResponse[SendMessageResponse]`；前端 `editAndRegenerate / regenerate` 取 `run` 字段调用 `attachRunStream`，与现有 `submit` 流程一致。
- 无 placeholder；每段代码均完整可粘贴。
