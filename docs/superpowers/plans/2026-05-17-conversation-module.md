# Conversation 模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 实现认证用户的 conversation CRUD、conversation detail 的可见消息读取，以及发送 user message 时创建 queued run。

**架构：** API 路由保持薄，只负责依赖注入、调用 service、提交事务和返回 `SuccessResponse`。`app/services/conversations/service.py` 承载 ownership、软删除、消息 position、active run 限制和 queued run 创建规则。provider、worker、SSE、取消和 regenerate 不进入本计划。

**技术栈：** Python 3.12、FastAPI、Pydantic v2、SQLAlchemy 2.0 async、PostgreSQL、pytest、httpx ASGITransport。

---

## 范围约束

本计划基于以下文档：

- `docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md`
- `docs/handover/2026-05-17-auth-and-response-envelope.md`
- `docs/architecture/module-boundaries.md`

本次实现包含：

- `POST /api/v1/conversations`
- `GET /api/v1/conversations`
- `GET /api/v1/conversations/{conversation_id}`
- `PATCH /api/v1/conversations/{conversation_id}`
- `DELETE /api/v1/conversations/{conversation_id}`
- `POST /api/v1/conversations/{conversation_id}/messages`
- conversation 软删除后从列表和详情隐藏，并禁止继续发送消息。
- conversation ownership 校验，跨用户访问返回 `404`。
- 发送消息时在同一事务中写入 user message，并创建 `queued` run。
- 每个 conversation 同时最多一个 active run，active 状态为 `queued`、`started`、`streaming`、`cancelling`。
- 所有 `/api/v1/*` JSON 成功响应继续使用 `{"data": ...}` envelope。

本次明确不做：

- SSE endpoint。
- run cancellation。
- regenerate。
- run event replay。
- context builder。
- provider interface、DeepSeek adapter、fake provider。
- worker claim、lease、heartbeat 和 recovery。
- 新 Alembic migration。现有 `20260516_0001_create_core_tables.py` 已包含本模块所需表。

项目规则：

- 直接在当前分支开发，不创建或切换 git worktree。
- 文档使用中文。
- 代码注释和 docstring 使用英文。
- 用户可见错误信息和应用提示使用英文。

## 文件结构

执行完成后，应新增或修改以下文件。

**Schemas：**

- Create: `app/schemas/conversations.py`，定义 conversation、message、run 的请求和响应 schema。
- Create: `tests/schemas/test_conversations.py`，覆盖 title/content 规范化和响应 schema 实例化。

**Service：**

- Create: `app/services/conversations/__init__.py`，导出 conversation service 的 public API。
- Create: `app/services/conversations/service.py`，实现 conversation CRUD、可见消息读取、发送消息创建 queued run。
- Create: `tests/services/conversations/test_service.py`，覆盖 service 业务规则。

**API：**

- Create: `app/api/v1/conversations.py`，实现 conversation 和 message API route。
- Modify: `app/main.py`，挂载 conversation router。
- Create: `tests/api/test_conversations.py`，覆盖认证、envelope、ownership 和 API 行为。

**不修改：**

- `alembic/versions/20260516_0001_create_core_tables.py`
- `app/models/conversation.py`
- `app/models/run.py`

## Task 1: Conversation Schemas

**Files:**

- Create: `app/schemas/conversations.py`
- Create: `tests/schemas/test_conversations.py`

- [ ] **Step 1: 写 schema 失败测试**

创建 `tests/schemas/test_conversations.py`：

```python
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.schemas.conversations import (
    ConversationCreateRequest,
    ConversationDetailResponse,
    ConversationRenameRequest,
    ConversationResponse,
    MessageCreateRequest,
    MessageResponse,
    RunResponse,
    SendMessageResponse,
)


def test_conversation_create_request_trims_blank_title_to_none() -> None:
    request = ConversationCreateRequest(title="   ")

    assert request.title is None


def test_conversation_create_request_trims_non_empty_title() -> None:
    request = ConversationCreateRequest(title="  Project chat  ")

    assert request.title == "Project chat"


def test_conversation_rename_request_rejects_blank_title() -> None:
    with pytest.raises(ValidationError):
        ConversationRenameRequest(title="   ")


def test_message_create_request_preserves_non_blank_content() -> None:
    request = MessageCreateRequest(content="  hello\n")

    assert request.content == "  hello\n"


def test_message_create_request_rejects_blank_content() -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(content=" \n\t ")


def test_conversation_detail_response_contains_visible_messages() -> None:
    now = datetime.now(UTC)
    conversation = ConversationResponse(
        id=1,
        title="Project chat",
        created_at=now,
        updated_at=now,
    )
    message = MessageResponse(
        id=10,
        conversation_id=1,
        run_id=20,
        role="user",
        content="Hello",
        position=1,
        created_at=now,
    )
    detail = ConversationDetailResponse(
        **conversation.model_dump(),
        messages=[message],
    )

    assert detail.id == 1
    assert detail.messages == [message]


def test_send_message_response_contains_message_and_run() -> None:
    now = datetime.now(UTC)
    message = MessageResponse(
        id=10,
        conversation_id=1,
        run_id=20,
        role="user",
        content="Hello",
        position=1,
        created_at=now,
    )
    run = RunResponse(
        id=20,
        conversation_id=1,
        user_message_id=10,
        status="queued",
        provider_name="deepseek",
        provider_model="deepseek-chat",
        created_at=now,
    )
    response = SendMessageResponse(message=message, run=run)

    assert response.message.id == 10
    assert response.run.status == "queued"
```

- [ ] **Step 2: 运行 schema 测试确认失败**

Run:

```bash
uv run pytest tests/schemas/test_conversations.py -v
```

Expected:

- FAIL。
- 失败原因包含 `ModuleNotFoundError: No module named 'app.schemas.conversations'`。

- [ ] **Step 3: 实现 conversation schema**

创建 `app/schemas/conversations.py`：

```python
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConversationCreateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: Any) -> Any:
        if isinstance(value, str):
            normalized = value.strip()
            return normalized or None
        return value


class ConversationRenameRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)

    @field_validator("title", mode="before")
    @classmethod
    def normalize_title(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value


class MessageCreateRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20000)

    @field_validator("content")
    @classmethod
    def reject_blank_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message content is required")
        return value


class ConversationResponse(BaseModel):
    id: int
    title: str | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MessageResponse(BaseModel):
    id: int
    conversation_id: int
    run_id: int | None
    role: Literal["user", "assistant"]
    content: str
    position: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RunResponse(BaseModel):
    id: int
    conversation_id: int
    user_message_id: int
    status: Literal[
        "queued",
        "started",
        "streaming",
        "succeeded",
        "failed",
        "cancelling",
        "cancelled",
    ]
    provider_name: str
    provider_model: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ConversationDetailResponse(ConversationResponse):
    messages: list[MessageResponse]


class SendMessageResponse(BaseModel):
    message: MessageResponse
    run: RunResponse
```

- [ ] **Step 4: 运行 schema 测试确认通过**

Run:

```bash
uv run pytest tests/schemas/test_conversations.py -v
```

Expected:

- PASS。

- [ ] **Step 5: 提交 schema**

Run:

```bash
git add app/schemas/conversations.py tests/schemas/test_conversations.py
git commit -m "feat: add conversation schemas"
```

Expected:

- commit 成功。

## Task 2: Conversation CRUD Service

**Files:**

- Create: `app/services/conversations/__init__.py`
- Create: `app/services/conversations/service.py`
- Create: `tests/services/conversations/test_service.py`

- [ ] **Step 1: 写 service CRUD 失败测试**

创建 `tests/services/conversations/test_service.py`：

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
from app.models.run import Run
from app.models.user import User
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    get_conversation_detail,
    list_conversations,
    rename_conversation,
)

TEST_DATABASE_URL = os.environ.get(
    "CONVERSATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "conversation-service-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
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


async def test_create_and_list_conversations_for_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        other_user = await create_user(session, "bob")

        first = await create_conversation(session, user=user, title=None)
        second = await create_conversation(session, user=user, title="Project chat")
        await create_conversation(session, user=other_user, title="Other chat")
        await session.commit()

        conversations = await list_conversations(session, user=user)

    assert [conversation.id for conversation in conversations] == [second.id, first.id]
    assert conversations[0].title == "Project chat"
    assert conversations[1].title is None


async def test_deleted_conversation_detail_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        visible = Message(
            conversation_id=conversation.id,
            role="user",
            content="Hello",
            position=1,
        )
        archived = Message(
            conversation_id=conversation.id,
            role="assistant",
            content="Old answer",
            position=2,
        )
        session.add_all([visible, archived])
        await session.flush()
        await delete_conversation(session, user=user, conversation_id=conversation.id)
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await get_conversation_detail(session, user=user, conversation_id=conversation.id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"


async def test_get_conversation_detail_hides_archived_messages(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        visible = Message(
            conversation_id=conversation.id,
            role="user",
            content="Hello",
            position=1,
        )
        archived = Message(
            conversation_id=conversation.id,
            role="assistant",
            content="Old answer",
            position=2,
        )
        session.add_all([visible, archived])
        await session.flush()
        archived.archived_at = datetime.now(UTC)
        await session.commit()

        detail = await get_conversation_detail(session, user=user, conversation_id=conversation.id)

    assert [message.id for message in detail.messages] == [visible.id]


async def test_rename_conversation_updates_title(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title=None)

        updated = await rename_conversation(
            session,
            user=user,
            conversation_id=conversation.id,
            title="  New title  ",
        )
        await session.commit()

    assert updated.title == "New title"
    assert updated.updated_at >= updated.created_at


async def test_cross_user_conversation_access_returns_not_found(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await create_user(session, "alice")
        other_user = await create_user(session, "bob")
        conversation = await create_conversation(session, user=owner, title="Private")
        await session.commit()

        with pytest.raises(AppError) as exc_info:
            await get_conversation_detail(session, user=other_user, conversation_id=conversation.id)

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"
```

- [ ] **Step 2: 运行 service CRUD 测试确认失败**

Run:

```bash
uv run pytest tests/services/conversations/test_service.py -v
```

Expected:

- FAIL。
- 失败原因包含 `ImportError` 或 `ModuleNotFoundError`，因为 `app.services.conversations.service` 尚不存在。

- [ ] **Step 3: 实现 service CRUD**

创建 `app/services/conversations/__init__.py`：

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    get_conversation_detail,
    list_conversations,
    rename_conversation,
)

__all__ = [
    "create_conversation",
    "delete_conversation",
    "get_conversation_detail",
    "list_conversations",
    "rename_conversation",
]
```

创建 `app/services/conversations/service.py`：

```python
from datetime import UTC, datetime

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.conversation import Conversation, Message
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

CONVERSATION_NOT_FOUND_MESSAGE = "Conversation not found"


def conversation_response(conversation: Conversation) -> ConversationResponse:
    return ConversationResponse.model_validate(conversation)


def message_response(message: Message) -> MessageResponse:
    return MessageResponse.model_validate(message)


async def create_conversation(
    session: AsyncSession,
    *,
    user: User,
    title: str | None,
) -> ConversationResponse:
    conversation = Conversation(user_id=user.id, title=normalize_optional_title(title))
    session.add(conversation)
    await session.flush()
    return conversation_response(conversation)


async def list_conversations(
    session: AsyncSession,
    *,
    user: User,
) -> list[ConversationResponse]:
    conversations = (
        await session.scalars(
            select(Conversation)
            .where(
                Conversation.user_id == user.id,
                Conversation.deleted_at.is_(None),
            )
            .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
        )
    ).all()
    return [conversation_response(conversation) for conversation in conversations]


async def get_conversation_detail(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> ConversationDetailResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    messages = (
        await session.scalars(
            select(Message)
            .where(
                Message.conversation_id == conversation.id,
                Message.archived_at.is_(None),
            )
            .order_by(Message.position.asc())
        )
    ).all()
    return ConversationDetailResponse(
        **conversation_response(conversation).model_dump(),
        messages=[message_response(message) for message in messages],
    )


async def rename_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
    title: str,
) -> ConversationResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    conversation.title = title.strip()
    conversation.updated_at = datetime.now(UTC)
    await session.flush()
    return conversation_response(conversation)


async def delete_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> CommandStatusResponse:
    conversation = await get_owned_visible_conversation(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    now = datetime.now(UTC)
    conversation.deleted_at = now
    conversation.updated_at = now
    await session.flush()
    return CommandStatusResponse()


async def get_owned_visible_conversation(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
    )
    if conversation is None:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    return conversation


def normalize_optional_title(title: str | None) -> str | None:
    if title is None:
        return None
    normalized = title.strip()
    return normalized or None
```

- [ ] **Step 4: 运行 service CRUD 测试确认通过**

Run:

```bash
uv run pytest tests/services/conversations/test_service.py -v
```

Expected:

- PASS。

- [ ] **Step 5: 提交 service CRUD**

Run:

```bash
git add app/services/conversations/__init__.py app/services/conversations/service.py tests/services/conversations/test_service.py
git commit -m "feat: add conversation service"
```

Expected:

- commit 成功。

## Task 3: Submit User Message Creates Queued Run

**Files:**

- Modify: `app/services/conversations/__init__.py`
- Modify: `app/services/conversations/service.py`
- Modify: `tests/services/conversations/test_service.py`

- [ ] **Step 1: 追加发送消息失败测试**

在 `tests/services/conversations/test_service.py` 导入区加入：

```python
from app.services.conversations.service import submit_user_message
```

如果已有 `from app.services.conversations.service import (...)` 多行导入，把 `submit_user_message` 合并到同一个导入块。

在文件末尾追加：

```python
async def test_submit_user_message_creates_message_and_queued_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")

        result = await submit_user_message(
            session,
            user=user,
            conversation_id=conversation.id,
            content="Hello",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

        stored_message = await session.get(Message, result.message.id)
        stored_run = await session.get(Run, result.run.id)

    assert result.message.role == "user"
    assert result.message.content == "Hello"
    assert result.message.position == 1
    assert result.message.run_id == result.run.id
    assert result.run.status == "queued"
    assert result.run.provider_name == "deepseek"
    assert result.run.provider_model == "deepseek-chat"
    assert result.run.user_message_id == result.message.id
    assert stored_message is not None
    assert stored_message.run_id == result.run.id
    assert stored_run is not None
    assert stored_run.status == "queued"


async def test_submit_user_message_uses_next_visible_position_after_terminal_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        previous_message = Message(
            conversation_id=conversation.id,
            role="user",
            content="First",
            position=1,
        )
        session.add(previous_message)
        await session.flush()
        previous_run = Run(
            conversation_id=conversation.id,
            user_message_id=previous_message.id,
            status="succeeded",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        session.add(previous_run)
        await session.flush()
        previous_message.run_id = previous_run.id

        result = await submit_user_message(
            session,
            user=user,
            conversation_id=conversation.id,
            content="Second",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )
        await session.commit()

    assert result.message.position == 2


async def test_submit_user_message_rejects_active_run(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        first = await submit_user_message(
            session,
            user=user,
            conversation_id=conversation.id,
            content="Hello",
            provider_name="deepseek",
            provider_model="deepseek-chat",
        )

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_id=conversation.id,
                content="Again",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert first.run.status == "queued"
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == "Active run already exists"


async def test_submit_user_message_rejects_deleted_conversation(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        conversation = await create_conversation(session, user=user, title="Project chat")
        await delete_conversation(session, user=user, conversation_id=conversation.id)

        with pytest.raises(AppError) as exc_info:
            await submit_user_message(
                session,
                user=user,
                conversation_id=conversation.id,
                content="Hello",
                provider_name="deepseek",
                provider_model="deepseek-chat",
            )

    assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
    assert exc_info.value.detail == "Conversation not found"
```

- [ ] **Step 2: 运行发送消息测试确认失败**

Run:

```bash
uv run pytest tests/services/conversations/test_service.py -v
```

Expected:

- FAIL。
- 失败原因包含 `ImportError: cannot import name 'submit_user_message'`。

- [ ] **Step 3: 实现发送消息和 queued run 创建**

修改 `app/services/conversations/service.py` 的导入：

```python
from sqlalchemy import func, select

from app.models.run import Run
from app.schemas.conversations import (
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
    RunResponse,
    SendMessageResponse,
)
```

在常量区加入：

```python
ACTIVE_RUN_STATUSES = ("queued", "started", "streaming", "cancelling")
ACTIVE_RUN_EXISTS_MESSAGE = "Active run already exists"
```

在 `message_response()` 后加入：

```python
def run_response(run: Run) -> RunResponse:
    return RunResponse.model_validate(run)
```

在 `delete_conversation()` 后加入：

```python
async def submit_user_message(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
    content: str,
    provider_name: str,
    provider_model: str,
) -> SendMessageResponse:
    conversation = await get_owned_visible_conversation_for_update(
        session,
        user=user,
        conversation_id=conversation_id,
    )
    await ensure_no_active_run(session, conversation_id=conversation.id)
    next_position = await get_next_message_position(session, conversation_id=conversation.id)

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content=content,
        position=next_position,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="queued",
        provider_name=provider_name,
        provider_model=provider_model,
    )
    session.add(run)
    await session.flush()

    message.run_id = run.id
    conversation.updated_at = datetime.now(UTC)
    await session.flush()

    return SendMessageResponse(
        message=message_response(message),
        run=run_response(run),
    )
```

在 `get_owned_visible_conversation()` 后加入：

```python
async def get_owned_visible_conversation_for_update(
    session: AsyncSession,
    *,
    user: User,
    conversation_id: int,
) -> Conversation:
    conversation = await session.scalar(
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            Conversation.user_id == user.id,
            Conversation.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if conversation is None:
        raise AppError(status.HTTP_404_NOT_FOUND, CONVERSATION_NOT_FOUND_MESSAGE)
    return conversation


async def ensure_no_active_run(session: AsyncSession, *, conversation_id: int) -> None:
    active_run_id = await session.scalar(
        select(Run.id).where(
            Run.conversation_id == conversation_id,
            Run.status.in_(ACTIVE_RUN_STATUSES),
        )
    )
    if active_run_id is not None:
        raise AppError(status.HTTP_409_CONFLICT, ACTIVE_RUN_EXISTS_MESSAGE)


async def get_next_message_position(session: AsyncSession, *, conversation_id: int) -> int:
    max_position = await session.scalar(
        select(func.coalesce(func.max(Message.position), 0)).where(
            Message.conversation_id == conversation_id
        )
    )
    return int(max_position) + 1
```

修改 `app/services/conversations/__init__.py`，加入 `submit_user_message`：

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    get_conversation_detail,
    list_conversations,
    rename_conversation,
    submit_user_message,
)

__all__ = [
    "create_conversation",
    "delete_conversation",
    "get_conversation_detail",
    "list_conversations",
    "rename_conversation",
    "submit_user_message",
]
```

- [ ] **Step 4: 运行发送消息测试确认通过**

Run:

```bash
uv run pytest tests/services/conversations/test_service.py -v
```

Expected:

- PASS。

- [ ] **Step 5: 提交发送消息 service**

Run:

```bash
git add app/services/conversations/__init__.py app/services/conversations/service.py tests/services/conversations/test_service.py
git commit -m "feat: create queued run when sending message"
```

Expected:

- commit 成功。

## Task 4: Conversation API Routes

**Files:**

- Create: `app/api/v1/conversations.py`
- Modify: `app/main.py`
- Create: `tests/api/test_conversations.py`

- [ ] **Step 1: 写 API 失败测试**

创建 `tests/api/test_conversations.py`：

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
from app.models.run import Run
from app.models.user import User

TEST_DATABASE_URL = os.environ.get(
    "CONVERSATION_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "conversation-api-test.example.com"


async def ready() -> bool:
    return True


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
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


async def test_conversation_crud_flow(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-conversation-api",
        email=f"alice@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    create_response = await client.post(
        "/api/v1/conversations",
        json={"title": "  Project chat  "},
        headers=headers,
    )
    list_response = await client.get("/api/v1/conversations", headers=headers)

    assert create_response.status_code == status.HTTP_201_CREATED
    created = create_response.json()["data"]
    assert created["title"] == "Project chat"
    assert set(created) == {"id", "title", "created_at", "updated_at"}
    assert list_response.status_code == status.HTTP_200_OK
    assert [item["id"] for item in list_response.json()["data"]] == [created["id"]]

    detail_response = await client.get(f"/api/v1/conversations/{created['id']}", headers=headers)
    rename_response = await client.patch(
        f"/api/v1/conversations/{created['id']}",
        json={"title": "Renamed"},
        headers=headers,
    )
    delete_response = await client.delete(
        f"/api/v1/conversations/{created['id']}",
        headers=headers,
    )
    missing_after_delete_response = await client.get(
        f"/api/v1/conversations/{created['id']}",
        headers=headers,
    )

    assert detail_response.status_code == status.HTTP_200_OK
    assert detail_response.json()["data"]["messages"] == []
    assert rename_response.status_code == status.HTTP_200_OK
    assert rename_response.json()["data"]["title"] == "Renamed"
    assert delete_response.status_code == status.HTTP_200_OK
    assert delete_response.json() == {"data": {"status": "ok"}}
    assert missing_after_delete_response.status_code == status.HTTP_404_NOT_FOUND
    assert missing_after_delete_response.json() == {"detail": "Conversation not found"}


async def test_send_message_creates_user_message_and_queued_run(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-message-api",
        email=f"alice-message@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)
    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]

    message_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Hello"},
        headers=headers,
    )
    second_message_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Again"},
        headers=headers,
    )
    detail_response = await client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)

    assert message_response.status_code == status.HTTP_201_CREATED
    data = message_response.json()["data"]
    assert data["message"]["role"] == "user"
    assert data["message"]["content"] == "Hello"
    assert data["message"]["position"] == 1
    assert data["message"]["run_id"] == data["run"]["id"]
    assert data["run"]["status"] == "queued"
    assert data["run"]["provider_name"] == "deepseek"
    assert data["run"]["provider_model"] == "deepseek-test"
    assert second_message_response.status_code == status.HTTP_409_CONFLICT
    assert second_message_response.json() == {"detail": "Active run already exists"}
    assert detail_response.json()["data"]["messages"][0]["content"] == "Hello"


async def test_conversation_routes_require_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/v1/conversations")

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.json() == {"detail": "Authentication required"}


async def test_cross_user_conversation_access_returns_not_found(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-private-api",
        email=f"alice-private@{TEST_EMAIL_DOMAIN}",
    )
    bob = await register_user(
        client,
        username="bob-private-api",
        email=f"bob-private@{TEST_EMAIL_DOMAIN}",
    )
    alice_headers = auth_headers(alice)
    bob_headers = auth_headers(bob)
    create_response = await client.post(
        "/api/v1/conversations",
        json={"title": "Private"},
        headers=alice_headers,
    )
    conversation_id = create_response.json()["data"]["id"]

    get_response = await client.get(f"/api/v1/conversations/{conversation_id}", headers=bob_headers)
    patch_response = await client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "Nope"},
        headers=bob_headers,
    )
    send_response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "Nope"},
        headers=bob_headers,
    )

    assert get_response.status_code == status.HTTP_404_NOT_FOUND
    assert patch_response.status_code == status.HTTP_404_NOT_FOUND
    assert send_response.status_code == status.HTTP_404_NOT_FOUND
```

- [ ] **Step 2: 运行 API 测试确认失败**

Run:

```bash
uv run pytest tests/api/test_conversations.py -v
```

Expected:

- FAIL。
- 失败原因是 `/api/v1/conversations` 返回 `404 Not Found`。

- [ ] **Step 3: 实现 conversation API route**

创建 `app/api/v1/conversations.py`：

```python
from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.models.user import User
from app.schemas.auth import CommandStatusResponse
from app.schemas.conversations import (
    ConversationCreateRequest,
    ConversationDetailResponse,
    ConversationRenameRequest,
    ConversationResponse,
    MessageCreateRequest,
    SendMessageResponse,
)
from app.schemas.responses import SuccessResponse
from app.services.auth.dependencies import get_current_user
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    get_conversation_detail,
    list_conversations,
    rename_conversation,
    submit_user_message,
)

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[ConversationResponse],
    response_model_exclude_none=True,
)
async def create_conversation_route(
    request: ConversationCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationResponse]:
    conversation = await create_conversation(
        session,
        user=current_user,
        title=request.title,
    )
    await session.commit()
    return SuccessResponse(data=conversation)


@router.get(
    "",
    response_model=SuccessResponse[list[ConversationResponse]],
    response_model_exclude_none=True,
)
async def list_conversations_route(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[list[ConversationResponse]]:
    conversations = await list_conversations(session, user=current_user)
    return SuccessResponse(data=conversations)


@router.get(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationDetailResponse],
    response_model_exclude_none=True,
)
async def get_conversation_route(
    conversation_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationDetailResponse]:
    conversation = await get_conversation_detail(
        session,
        user=current_user,
        conversation_id=conversation_id,
    )
    return SuccessResponse(data=conversation)


@router.patch(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationResponse],
    response_model_exclude_none=True,
)
async def rename_conversation_route(
    conversation_id: int,
    request: ConversationRenameRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[ConversationResponse]:
    conversation = await rename_conversation(
        session,
        user=current_user,
        conversation_id=conversation_id,
        title=request.title,
    )
    await session.commit()
    return SuccessResponse(data=conversation)


@router.delete(
    "/{conversation_id}",
    response_model=SuccessResponse[CommandStatusResponse],
    response_model_exclude_none=True,
)
async def delete_conversation_route(
    conversation_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SuccessResponse[CommandStatusResponse]:
    result = await delete_conversation(
        session,
        user=current_user,
        conversation_id=conversation_id,
    )
    await session.commit()
    return SuccessResponse(data=result)


@router.post(
    "/{conversation_id}/messages",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[SendMessageResponse],
    response_model_exclude_none=True,
)
async def send_message_route(
    conversation_id: int,
    request: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[SendMessageResponse]:
    result = await submit_user_message(
        session,
        user=current_user,
        conversation_id=conversation_id,
        content=request.content,
        provider_name="deepseek",
        provider_model=settings.deepseek_model,
    )
    await session.commit()
    return SuccessResponse(data=result)
```

- [ ] **Step 4: 挂载 router**

修改 `app/main.py` 的 imports：

```python
from app.api.v1.auth import router as auth_router
from app.api.v1.conversations import router as conversations_router
```

修改 `create_app()` 内 router 挂载：

```python
    app = FastAPI(title="iChat API")
    app.include_router(auth_router)
    app.include_router(conversations_router)
```

- [ ] **Step 5: 运行 API 测试确认通过**

Run:

```bash
uv run pytest tests/api/test_conversations.py -v
```

Expected:

- PASS。

- [ ] **Step 6: 提交 API routes**

Run:

```bash
git add app/api/v1/conversations.py app/main.py tests/api/test_conversations.py
git commit -m "feat: add conversation api"
```

Expected:

- commit 成功。

## Task 5: Focused Regression And Quality Gates

**Files:**

- Modify only if checks reveal issues in files touched by Tasks 1-4.

- [ ] **Step 1: 运行 Conversation focused tests**

Run:

```bash
uv run pytest \
  tests/schemas/test_conversations.py \
  tests/services/conversations/test_service.py \
  tests/api/test_conversations.py \
  -v
```

Expected:

- PASS。

- [ ] **Step 2: 运行 Auth + Conversation API tests**

Run:

```bash
uv run pytest tests/api/test_app.py tests/api/test_auth.py tests/api/test_conversations.py -v
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

- [ ] **Step 4: 运行 ruff**

Run:

```bash
uv run ruff check .
```

Expected:

```text
All checks passed!
```

- [ ] **Step 5: 运行 mypy**

Run:

```bash
uv run mypy .
```

Expected:

```text
Success: no issues found in ... source files
```

- [ ] **Step 6: 修复检查中发现的问题**

只修改本计划引入或触碰的文件。常见修复方式：

- 如果 ruff 报导入排序问题，运行 `uv run ruff check . --fix`，再重新执行 Step 4。
- 如果 mypy 报 `Any` 或 `dict` 类型不明确，在测试 helper 返回值处使用 `dict[str, Any]` 和 `cast()`，再重新执行 Step 5。
- 如果 API 测试因测试数据重复失败，确认测试用户名或 email 使用了当前测试域名并在 fixture 中清理。

- [ ] **Step 7: 提交质量门修复**

如果 Step 6 修改了文件，运行：

```bash
git add app tests
git commit -m "test: verify conversation module"
```

Expected:

- 如果有修改，commit 成功。
- 如果没有修改，跳过本步骤。

## 验收标准

完成后应满足：

- 未认证访问 conversation API 返回 `401` 和 `{"detail": "Authentication required"}`。
- 用户只能访问自己的 conversation；跨用户访问详情、重命名、发送消息返回 `404`。
- 创建 conversation 返回 `201` 和 `{"data": {"id", "title", "created_at", "updated_at"}}`。
- 列表只返回当前用户未软删除 conversation，并按 `updated_at desc, id desc` 排序。
- 详情返回 conversation 和未归档 messages。
- 重命名会 trim title 并更新 `updated_at`。
- 删除为软删除，返回 `{"data": {"status": "ok"}}`。
- 删除后详情和发送消息都返回 `404`。
- 发送消息在同一事务中创建 user message 和 `queued` run。
- 新 message 的 `run_id` 指向新 run。
- active run 存在时，再发送消息返回 `409` 和 `{"detail": "Active run already exists"}`。
- provider 名称固定为 `deepseek`，model 来自 `settings.deepseek_model`。
- 不调用 DeepSeek，不启动 worker，不写 run events。
- `uv run pytest`、`uv run ruff check .`、`uv run mypy .` 全部通过。

## 后续计划入口

本计划完成后，下一份计划建议是 `Run Events And SSE Replay`，范围包括：

- run event 写入和 seq 分配。
- `GET /api/v1/runs/{run_id}/events?after_seq=0`。
- fake persisted events replay。
- terminal event 后关闭 SSE stream。

再下一份计划是 `Run Cancellation And Regenerate`，然后才进入 `Context Builder + Provider + Worker`。

## 自检

**规格覆盖：**

- Conversation 创建、列表、详情、重命名、软删除：Task 2 和 Task 4 覆盖。
- Message 发送和 queued run 创建：Task 3 和 Task 4 覆盖。
- 每个 conversation 一个 active run：Task 3 覆盖。
- 用户 ownership：Task 2 和 Task 4 覆盖。
- 统一成功响应 envelope：Task 4 覆盖。
- Provider/worker/SSE/cancel/regenerate：本计划明确排除，并在后续计划入口列出。

**未完成标记扫描：**

- 本计划没有未完成标记或空泛执行步骤。
- 每个代码修改步骤都给出具体文件和代码块。
- 每个测试步骤都给出具体命令和预期结果。

**类型一致性：**

- API route、service 和 tests 均使用 `ConversationResponse`、`ConversationDetailResponse`、`MessageResponse`、`RunResponse`、`SendMessageResponse`。
- `submit_user_message()` 的参数在 service、API route 和 tests 中保持一致。
- active run 状态与 ORM partial unique index 保持一致：`queued`、`started`、`streaming`、`cancelling`。
